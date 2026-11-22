//! Título, descrição, autor e texto alternativo (Lote 9): leitura do XMP e gravação em XMP
//! (`dc:title`, `dc:description`, `dc:creator`, `Iptc4xmpCore:AltTextAccessibility`) e em IPTC-IIM
//! (2:05, 2:120, 2:80). O resto do pacote e dos registros é preservado.
//! Texto vem do usuário ou do arquivo: nada aqui entra em shell, e ninguém faz `unwrap` em fatia.
use super::encode::xml_escape;
use crate::commands::describe::MetadataEdits;
use std::ops::Range;

/// Teto de caracteres de cada campo (uma edição maior é cortada, nunca recusada).
pub const MAX_CHARS: usize = 16_384;
/// Teto do texto que `xml_unescape` processa (o resto é descartado).
pub const MAX_UNESCAPE: usize = 1 << 16;
/// Teto do pacote XMP lido para exibir (a gravação preserva o pacote inteiro).
pub const MAX_XMP: usize = 4 << 20;
/// Tetos em bytes no IPTC-IIM (o XMP guarda o texto inteiro).
const IIM_TITLE: usize = 256;
const IIM_AUTHOR: usize = 256;
const IIM_CAPTION: usize = 2000;
/// Teto de registros IIM lidos de um arquivo forjado.
const MAX_IIM_RECORDS: usize = 10_000;
/// Teto de itens `rdf:li` lidos de uma propriedade.
const MAX_ITEMS: usize = 64;

const NS_DC: &str = "http://purl.org/dc/elements/1.1/";
const NS_IPTC: &str = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";

/// Prefixo de `s` com até `max` bytes, sem partir um caractere.
pub fn cap_str(s: &str, max: usize) -> &str {
    let mut n = s.len().min(max);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    &s[..n]
}

/// Tira controles (menos quebra de linha e tabulação), normaliza `\r\n` e corta no teto.
pub fn clean(s: &str) -> String {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: String = s
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(MAX_CHARS)
        .collect();
    let end = out.trim_end().len();
    out.truncate(end);
    out.trim_start().to_string()
}

impl MetadataEdits {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.description.is_none()
            && self.author.is_none()
            && self.alt_text.is_none()
    }

    /// Cópia com os textos limpos; `Some("")` continua significando "apagar o campo".
    pub fn cleaned(&self) -> MetadataEdits {
        let c = |v: &Option<String>| v.as_deref().map(clean);
        MetadataEdits {
            title: c(&self.title),
            description: c(&self.description),
            author: c(&self.author),
            alt_text: c(&self.alt_text),
        }
    }
}

// ---------- XMP ----------

#[derive(Clone, Copy)]
enum Kind {
    LangAlt,
    Seq,
}

/// `(propriedade, prefixo, namespace, tipo)` de cada campo editável, na ordem de `MetadataEdits`.
const PROPS: [(&str, &str, &str, Kind); 4] = [
    ("dc:title", "dc", NS_DC, Kind::LangAlt),
    ("dc:description", "dc", NS_DC, Kind::LangAlt),
    ("dc:creator", "dc", NS_DC, Kind::Seq),
    (
        "Iptc4xmpCore:AltTextAccessibility",
        "Iptc4xmpCore",
        NS_IPTC,
        Kind::LangAlt,
    ),
];

fn element(name: &str, value: &str, kind: Kind) -> String {
    let v = xml_escape(value);
    match kind {
        Kind::LangAlt => format!(
            "<{name}><rdf:Alt><rdf:li xml:lang=\"x-default\">{v}</rdf:li></rdf:Alt></{name}>"
        ),
        Kind::Seq => format!("<{name}><rdf:Seq><rdf:li>{v}</rdf:li></rdf:Seq></{name}>"),
    }
}

/// Intervalo do elemento `<name ...>...</name>` (ou `<name/>`) em `x`.
fn find_element(x: &str, name: &str) -> Option<Range<usize>> {
    let open = format!("<{name}");
    for (start, _) in x.match_indices(&open) {
        let after = x.get(start + open.len()..)?;
        let next = after.chars().next()?;
        if !(next == '>' || next == '/' || next.is_whitespace()) {
            continue; // outro nome com o mesmo começo (`dc:titleX`)
        }
        let tag_end = start + open.len() + after.find('>')?;
        if x.get(..tag_end)?.ends_with('/') {
            return Some(start..tag_end + 1);
        }
        let close = format!("</{name}>");
        let end = tag_end + x.get(tag_end..)?.find(&close)? + close.len();
        return Some(start..end);
    }
    None
}

/// Remove TODAS as ocorrências da propriedade `name` (elementos e atributos) e devolve onde estava
/// o primeiro elemento, para o texto novo entrar no mesmo lugar.
fn remove_all(x: &mut String, name: &str) -> Option<usize> {
    let attr = format!(" {name}=");
    for _ in 0..MAX_ITEMS * 16 {
        let Some(p) = x.find(&attr) else { break };
        let q = p + attr.len();
        let quote = match x.as_bytes().get(q) {
            Some(&b @ (b'"' | b'\'')) => b as char,
            _ => break,
        };
        let Some(end) = x[q + 1..].find(quote) else {
            break;
        };
        x.replace_range(p..q + 1 + end + 1, "");
    }
    let mut first = None;
    for _ in 0..MAX_ITEMS * 16 {
        let Some(r) = find_element(x, name) else {
            break;
        };
        first.get_or_insert(r.start);
        x.replace_range(r, "");
    }
    first
}

/// Pacote XMP com os campos de `e` trocados (ou acrescentados); `Some("")` remove a propriedade.
/// O restante do pacote original fica como estava.
pub fn xmp_with_edits(orig: Option<&str>, e: &MetadataEdits) -> String {
    let values = [&e.title, &e.description, &e.author, &e.alt_text];
    let mut x = orig.unwrap_or("").to_string();
    let mut missing: Vec<(usize, String)> = Vec::new();
    for (i, v) in values.iter().enumerate() {
        let Some(v) = v.as_deref().map(clean) else {
            continue;
        };
        let (name, _, _, kind) = PROPS[i];
        let new = if v.is_empty() {
            String::new()
        } else {
            element(name, &v, kind)
        };
        match remove_all(&mut x, name) {
            Some(at) => x.insert_str(at, &new),
            None if !new.is_empty() => missing.push((i, new)),
            None => {}
        }
    }
    if missing.is_empty() {
        return x;
    }
    let mut ns = String::new();
    let mut body = String::new();
    for (i, el) in &missing {
        let (_, prefix, uri, _) = PROPS[*i];
        let decl = format!(" xmlns:{prefix}=\"{uri}\"");
        if !ns.contains(&decl) {
            ns.push_str(&decl);
        }
        body.push_str(el);
    }
    let block = format!("<rdf:Description rdf:about=\"\"{ns}>{body}</rdf:Description>");
    if let Some(end) = x.rfind("</rdf:RDF>") {
        x.insert_str(end, &block);
        return x;
    }
    format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">{block}</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
}

pub fn xml_unescape(s: &str) -> String {
    let s = cap_str(s, MAX_UNESCAPE);
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let decoded = rest.as_bytes().iter().take(11).position(|&b| b == b';').and_then(|e| {
            let ent = &rest[1..e];
            let ch = match ent {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => ent.strip_prefix('#').and_then(|n| {
                    let code = match n.strip_prefix(['x', 'X']) {
                        Some(h) => u32::from_str_radix(h, 16).ok()?,
                        None => n.parse().ok()?,
                    };
                    char::from_u32(code)
                }),
            };
            ch.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, used)) => {
                out.push(c);
                rest = &rest[used..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `(atributos, texto)` de cada `<rdf:li>` do trecho.
fn list_items(inner: &str) -> Vec<(&str, String)> {
    let mut out = Vec::new();
    for part in inner.split("<rdf:li").skip(1).take(MAX_ITEMS) {
        let Some(gt) = part.find('>') else { continue };
        let attrs = &part[..gt];
        if attrs.ends_with('/') {
            continue;
        }
        let Some(end) = part.find("</rdf:li>") else {
            continue;
        };
        if gt < end {
            out.push((attrs, xml_unescape(part[gt + 1..end].trim())));
        }
    }
    out
}

/// Texto de uma propriedade do XMP: o `x-default` (ou o primeiro) de uma lista de idiomas;
/// os itens de uma sequência, separados por vírgula; ou o texto simples do elemento.
pub fn xmp_text(xmp: &str, name: &str) -> Option<String> {
    let xmp = cap_str(xmp, MAX_XMP);
    let r = find_element(xmp, name)?;
    let el = xmp.get(r)?;
    let from = el.find('>')? + 1;
    let to = el.rfind("</").filter(|&b| b >= from).unwrap_or(el.len());
    let inner = &el[from..to];
    let items = list_items(inner);
    let text = if items.is_empty() {
        let plain = inner.trim();
        if plain.contains('<') {
            return None;
        }
        xml_unescape(plain)
    } else if inner.contains("<rdf:Alt") {
        let it = items
            .iter()
            .find(|(a, _)| a.contains("x-default"))
            .unwrap_or(&items[0]);
        it.1.clone()
    } else {
        items
            .iter()
            .map(|(_, t)| t.as_str())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let text = clean(&text);
    (!text.is_empty()).then_some(text)
}

/// Textos que o Inspetor edita, como estão no arquivo.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Texts {
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub alt_text: Option<String>,
}

/// XMP primeiro; sem ele, os campos IPTC (rótulos de `metadata::iptc_label`) e, para
/// descrição e autor, o EXIF (`ImageDescription`, `Artist`).
pub fn texts_of(xmp: Option<&str>, iptc: &[(String, String)], exif: &[(String, String)]) -> Texts {
    let x = |name| xmp.and_then(|x| xmp_text(x, name));
    let row = |rows: &[(String, String)], key: &str| {
        rows.iter()
            .find(|(k, v)| k == key && !v.trim().is_empty())
            .map(|(_, v)| clean(v))
            .filter(|v| !v.is_empty())
    };
    Texts {
        title: x(PROPS[0].0).or_else(|| row(iptc, "Title")),
        description: x(PROPS[1].0)
            .or_else(|| row(iptc, "Caption"))
            .or_else(|| row(exif, "ImageDescription")),
        author: x(PROPS[2].0)
            .or_else(|| row(iptc, "Creator"))
            .or_else(|| row(exif, "Artist")),
        alt_text: x(PROPS[3].0),
    }
}

// ---------- EXIF ----------

/// Tags do IFD0 que repetem cada texto editável: Artist/XPAuthor, ImageDescription/XPComment e XPTitle.
const EXIF_TITLE: [u16; 1] = [0x9C9B];
const EXIF_DESCRIPTION: [u16; 2] = [0x010E, 0x9C9C];
const EXIF_AUTHOR: [u16; 2] = [0x013B, 0x9C9D];

/// Bloco EXIF sem o valor antigo dos campos editados: tira do IFD0 as entradas deles e zera os bytes
/// dos valores. O novo texto vai para o XMP e o IPTC. O resto do EXIF fica como estava; um bloco que
/// não dá para ler com segurança volta como veio.
pub fn exif_without_text(tiff: &[u8], e: &MetadataEdits) -> Vec<u8> {
    let mut drop: Vec<u16> = Vec::new();
    if e.title.is_some() {
        drop.extend(EXIF_TITLE);
    }
    if e.description.is_some() {
        drop.extend(EXIF_DESCRIPTION);
    }
    if e.author.is_some() {
        drop.extend(EXIF_AUTHOR);
    }
    let mut out = tiff.to_vec();
    if !drop.is_empty() {
        let _ = scrub_ifd0(&mut out, &drop);
    }
    out
}

fn scrub_ifd0(b: &mut [u8], drop: &[u16]) -> Option<()> {
    let (ifd, le) = super::makernote::tiff_header(b)?;
    let u16_at = |b: &[u8], o: usize| -> Option<u16> {
        let a: [u8; 2] = b.get(o..o.checked_add(2)?)?.try_into().ok()?;
        Some(if le { u16::from_le_bytes(a) } else { u16::from_be_bytes(a) })
    };
    let u32_at = |b: &[u8], o: usize| -> Option<u32> {
        let a: [u8; 4] = b.get(o..o.checked_add(4)?)?.try_into().ok()?;
        Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    };
    let n = usize::from(u16_at(b, ifd)?);
    let first = ifd.checked_add(2)?;
    let end = first.checked_add(n * 12)?;
    let next: [u8; 4] = b.get(end..end.checked_add(4)?)?.try_into().ok()?;
    let mut keep: Vec<[u8; 12]> = Vec::with_capacity(n);
    let mut zero: Vec<(usize, usize)> = Vec::new();
    for i in 0..n {
        let o = first + i * 12;
        let entry: [u8; 12] = b.get(o..o + 12)?.try_into().ok()?;
        if !drop.contains(&u16_at(b, o)?) {
            keep.push(entry);
            continue;
        }
        let unit = match u16_at(b, o + 2)? {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 => 4,
            5 | 10 | 12 => 8,
            _ => 0,
        };
        let len = unit * (u32_at(b, o + 4)? as usize);
        if len > 4 {
            zero.push((u32_at(b, o + 8)? as usize, len));
        }
    }
    if keep.len() == n {
        return Some(());
    }
    for (off, len) in zero {
        if let Some(v) = off.checked_add(len).and_then(|e| b.get_mut(off..e)) {
            v.fill(0);
        }
    }
    let count = if le { (keep.len() as u16).to_le_bytes() } else { (keep.len() as u16).to_be_bytes() };
    b[ifd..ifd + 2].copy_from_slice(&count);
    let mut o = first;
    for entry in &keep {
        b[o..o + 12].copy_from_slice(entry);
        o += 12;
    }
    b[o..end].fill(0);
    b[o..o + 4].copy_from_slice(&next);
    b[o + 4..end + 4].fill(0);
    Some(())
}

// ---------- IPTC-IIM ----------

/// IIM com os registros 2:05 (título), 2:120 (legenda) e 2:80 (autor) trocados conforme `e`
/// (`Some("")` apaga) e o resto mantido; declara UTF-8 (1:90) e ordena por registro/conjunto.
pub fn iim_with_edits(orig: Option<&[u8]>, e: &MetadataEdits) -> Vec<u8> {
    let fields: [(u8, &Option<String>, usize); 3] = [
        (5, &e.title, IIM_TITLE),
        (120, &e.description, IIM_CAPTION),
        (80, &e.author, IIM_AUTHOR),
    ];
    let mut records: Vec<(u8, u8, Vec<u8>)> = Vec::new();
    let mut d = orig.unwrap_or(&[]);
    while d.len() >= 5 && d[0] == 0x1C && records.len() < MAX_IIM_RECORDS {
        let len = u16::from_be_bytes([d[3], d[4]]) as usize;
        if len & 0x8000 != 0 || d.len() < 5 + len {
            break;
        }
        let (r, n) = (d[1], d[2]);
        let replaced = r == 2 && fields.iter().any(|(num, v, _)| *num == n && v.is_some());
        if !replaced && !(r == 1 && n == 90) {
            records.push((r, n, d[5..5 + len].to_vec()));
        }
        d = &d[5 + len..];
    }
    records.push((1, 90, b"\x1B%G".to_vec()));
    for (num, v, max) in fields {
        if let Some(v) = v.as_deref().map(clean).filter(|v| !v.is_empty()) {
            records.push((2, num, cap_str(&v, max).as_bytes().to_vec()));
        }
    }
    records.sort_by_key(|(r, n, _)| (*r, *n)); // estável: palavras-chave repetidas mantêm a ordem
    let mut out = Vec::new();
    for (r, n, v) in records {
        out.extend_from_slice(&[0x1C, r, n]);
        out.extend_from_slice(&(v.len() as u16).to_be_bytes());
        out.extend_from_slice(&v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edits(t: &str, d: &str, a: &str, alt: &str) -> MetadataEdits {
        MetadataEdits {
            title: Some(t.into()),
            description: Some(d.into()),
            author: Some(a.into()),
            alt_text: Some(alt.into()),
        }
    }

    #[test]
    fn xmp_novo_traz_os_quatro_campos_e_relê() {
        let x = xmp_with_edits(None, &edits("Título & <1>", "Desc\nlinha 2", "Ana", "Um gato"));
        assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("Título & <1>"));
        assert_eq!(xmp_text(&x, "dc:description").as_deref(), Some("Desc\nlinha 2"));
        assert_eq!(xmp_text(&x, "dc:creator").as_deref(), Some("Ana"));
        assert_eq!(
            xmp_text(&x, "Iptc4xmpCore:AltTextAccessibility").as_deref(),
            Some("Um gato")
        );
        assert!(x.contains("xmlns:Iptc4xmpCore=") && x.contains("xmlns:dc="));
    }

    #[test]
    fn xmp_troca_no_lugar_e_preserva_o_resto() {
        let orig = "<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=\"\" xmlns:dc=\"d\" xmlns:xmp=\"x\" xmp:Rating=\"4\"><dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Velho</rdf:li></rdf:Alt></dc:title><dc:subject><rdf:Bag><rdf:li>k</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>";
        let e = MetadataEdits {
            title: Some("Novo".into()),
            ..Default::default()
        };
        let x = xmp_with_edits(Some(orig), &e);
        assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("Novo"));
        assert!(x.contains("xmp:Rating=\"4\"") && x.contains("<rdf:li>k</rdf:li>"));
        assert!(!x.contains("Velho"));
        assert_eq!(x.matches("dc:title>").count(), 2);
    }

    #[test]
    fn xmp_campo_vazio_remove_a_propriedade_e_none_mantem() {
        let base = xmp_with_edits(None, &edits("T", "D", "A", "X"));
        let e = MetadataEdits {
            title: Some("  ".into()),
            ..Default::default()
        };
        let x = xmp_with_edits(Some(&base), &e);
        assert_eq!(xmp_text(&x, "dc:title"), None);
        assert_eq!(xmp_text(&x, "dc:description").as_deref(), Some("D"));
    }

    #[test]
    fn xmp_nome_parecido_nao_confunde() {
        let orig = "<rdf:RDF><rdf:Description><dc:titleX>nao</dc:titleX></rdf:Description></rdf:RDF>";
        assert_eq!(xmp_text(orig, "dc:title"), None);
        let e = MetadataEdits {
            title: Some("Sim".into()),
            ..Default::default()
        };
        let x = xmp_with_edits(Some(orig), &e);
        assert!(x.contains("<dc:titleX>nao</dc:titleX>"));
        assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("Sim"));
    }

    #[test]
    fn xmp_le_idiomas_entidades_e_autor_multiplo() {
        let x = "<rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang=\"en\">One</rdf:li><rdf:li xml:lang=\"x-default\">Padr&#227;o &amp; &#x41;</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator><dc:description>simples</dc:description></rdf:Description>";
        assert_eq!(xmp_text(x, "dc:title").as_deref(), Some("Padrão & A"));
        assert_eq!(xmp_text(x, "dc:creator").as_deref(), Some("A, B"));
        assert_eq!(xmp_text(x, "dc:description").as_deref(), Some("simples"));
    }

    #[test]
    fn xmp_adulterado_nao_panica() {
        for x in [
            "",
            "<dc:title",
            "<dc:title>",
            "<dc:title/>",
            "<dc:title><rdf:Alt><rdf:li",
            "<dc:title><rdf:li></rdf:li>",
            "<dc:title><rdf:Alt><rdf:li>&#99999999999;&#x;&;&",
            "<dc:title>é</dc:title",
            "</dc:title><dc:title>",
        ] {
            let _ = xmp_text(x, "dc:title");
            let e = edits("a", "b", "c", "d");
            let _ = xmp_with_edits(Some(x), &e);
        }
        let grande = format!("<dc:title>{}</dc:title>", "<rdf:li>x</rdf:li>".repeat(100_000));
        assert!(xmp_text(&grande, "dc:title").unwrap().len() < 1000);
    }

    #[test]
    fn texto_limpo_sem_controles_e_com_teto() {
        assert_eq!(clean("  a\u{0}b\u{7}\r\nc\u{1b} "), "ab\nc");
        assert_eq!(clean(&"é".repeat(MAX_CHARS + 50)).chars().count(), MAX_CHARS);
        let x = xmp_with_edits(None, &edits("a\u{0}b", "", "", ""));
        assert!(!x.contains('\u{0}'));
    }

    #[test]
    fn iim_troca_so_os_campos_editados_e_ordena() {
        let orig = iim(&[(2, 25, "kw1"), (2, 5, "Velho"), (2, 116, "©"), (2, 25, "kw2")]);
        let e = MetadataEdits {
            title: Some("Novo".into()),
            author: Some("Ana".into()),
            ..Default::default()
        };
        let out = iim_with_edits(Some(&orig), &e);
        let recs = records(&out);
        assert_eq!(recs[0], (1, 90, "\u{1b}%G".into()));
        let nums: Vec<u8> = recs.iter().map(|r| r.1).collect();
        assert_eq!(nums, [90, 5, 25, 25, 80, 116]);
        assert!(recs.contains(&(2, 5, "Novo".into())));
        assert!(recs.contains(&(2, 80, "Ana".into())));
        assert!(recs.contains(&(2, 116, "©".into())));
    }

    #[test]
    fn iim_vazio_apaga_e_corta_em_caractere() {
        let orig = iim(&[(2, 120, "legenda")]);
        let e = MetadataEdits {
            description: Some(String::new()),
            title: Some("é".repeat(400)),
            ..Default::default()
        };
        let out = iim_with_edits(Some(&orig), &e);
        let recs = records(&out);
        assert!(!recs.iter().any(|r| r.1 == 120));
        let t = recs.iter().find(|r| r.1 == 5).unwrap();
        assert_eq!(t.2.len(), 256);
        assert!(!t.2.contains('\u{FFFD}'));
    }

    #[test]
    fn iim_truncado_ou_forjado_nao_panica() {
        let e = edits("a", "b", "c", "d");
        for orig in [
            vec![],
            vec![0x1C],
            vec![0x1C, 2, 5, 0, 200, b'x'],
            vec![0x1C, 2, 5, 0x80, 0x01, 1, 2],
            vec![0x1C, 2, 5, 0xFF, 0xFF],
        ] {
            let _ = iim_with_edits(Some(&orig), &e);
        }
        let muitos = iim(&vec![(2, 25, "k"); 20_000]);
        let out = iim_with_edits(Some(&muitos), &e);
        assert!(records(&out).len() < MAX_IIM_RECORDS + 10);
    }

    #[test]
    fn texts_of_prefere_xmp_e_cai_para_iptc_e_exif() {
        let x = xmp_with_edits(None, &edits("T", "", "", ""));
        let iptc = vec![("Title".into(), "IT".into()), ("Caption".into(), "IC".into())];
        let exif = vec![("Artist".into(), "Fulano".into())];
        let t = texts_of(Some(&x), &iptc, &exif);
        assert_eq!(t.title.as_deref(), Some("T"));
        assert_eq!(t.description.as_deref(), Some("IC"));
        assert_eq!(t.author.as_deref(), Some("Fulano"));
        assert_eq!(t.alt_text, None);
    }

    fn ascii(s: &str) -> (u32, Vec<u8>) {
        let mut b = s.as_bytes().to_vec();
        b.push(0);
        (b.len() as u32, b)
    }

    fn utf16(s: &str) -> (u32, Vec<u8>) {
        let mut b: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
        b.extend_from_slice(&[0, 0]);
        (b.len() as u32, b)
    }

    fn ent(tag: u16, ty: u16, v: (u32, Vec<u8>)) -> (u16, u16, u32, Vec<u8>) {
        (tag, ty, v.0, v.1)
    }

    fn exif_com_textos() -> Vec<u8> {
        crate::image::test_util::tiff_le(&[
            ent(0x010E, 2, ascii("Descricao antiga")),
            ent(0x010F, 2, ascii("Gera")),
            ent(0x013B, 2, ascii("Antigo Autor")),
            ent(0x9C9B, 1, utf16("Titulo XP antigo")),
            ent(0x9C9C, 1, utf16("Comentario XP antigo")),
            ent(0x9C9D, 1, utf16("Autor XP antigo")),
        ])
    }

    fn tem(b: &[u8], s: &str) -> bool {
        let u: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
        b.windows(s.len()).any(|w| w == s.as_bytes()) || b.windows(u.len()).any(|w| w == u)
    }

    #[test]
    fn exif_apaga_autor_e_descricao_antigos_e_guarda_o_resto() {
        let orig = exif_com_textos();
        let e = MetadataEdits {
            author: Some("Ana".into()),
            description: Some(String::new()),
            ..Default::default()
        };
        let out = exif_without_text(&orig, &e);
        for velho in ["Antigo Autor", "Autor XP antigo", "Descricao antiga", "Comentario XP antigo"] {
            assert!(!tem(&out, velho), "{velho} ainda no EXIF");
        }
        // o título não foi editado: XPTitle e Make ficam
        assert!(tem(&out, "Titulo XP antigo") && tem(&out, "Gera"));
        let r = exif::Reader::new().read_raw(out).unwrap();
        assert!(r.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        assert!(r.get_field(exif::Tag::Artist, exif::In::PRIMARY).is_none());
        assert!(r.get_field(exif::Tag::ImageDescription, exif::In::PRIMARY).is_none());
    }

    #[test]
    fn exif_sem_edicao_ou_malformado_volta_como_veio() {
        let orig = exif_com_textos();
        assert_eq!(exif_without_text(&orig, &MetadataEdits::default()), orig);
        let e = MetadataEdits { author: Some("x".into()), ..Default::default() };
        for n in 0..orig.len() {
            let _ = exif_without_text(&orig[..n], &e);
        }
        let mut forjado = orig.clone();
        forjado[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(exif_without_text(&forjado, &e), forjado);
    }

    #[test]
    fn xmp_remove_todas_as_ocorrencias_da_propriedade() {
        let dup = "<rdf:RDF><rdf:Description dc:creator=\"Atributo Velho\"><dc:creator><rdf:Seq><rdf:li>Velho 1</rdf:li></rdf:Seq></dc:creator></rdf:Description><rdf:Description><dc:creator><rdf:Seq><rdf:li>Velho 2</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF>";
        let e = MetadataEdits { author: Some("Ana".into()), ..Default::default() };
        let x = xmp_with_edits(Some(dup), &e);
        assert!(!x.contains("Velho"), "{x}");
        assert_eq!(x.matches("<dc:creator>").count(), 1);
        assert_eq!(xmp_text(&x, "dc:creator").as_deref(), Some("Ana"));
        let e = MetadataEdits { author: Some(String::new()), ..Default::default() };
        assert!(!xmp_with_edits(Some(dup), &e).contains("Velho"));
    }

    #[test]
    fn unescape_e_leitura_do_xmp_sao_lineares_com_muitos_e_comerciais() {
        let t = std::time::Instant::now();
        let muitos = "&".repeat(1 << 20);
        assert_eq!(xml_unescape(&muitos).len(), MAX_UNESCAPE);
        let xmp = format!("<dc:title>{muitos}</dc:title>");
        let _ = xmp_text(&xmp, "dc:title");
        let _ = texts_of(Some(&xmp), &[], &[]);
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
    }

    fn iim(v: &[(u8, u8, &str)]) -> Vec<u8> {
        let mut o = Vec::new();
        for (r, n, s) in v {
            o.extend_from_slice(&[0x1C, *r, *n]);
            o.extend_from_slice(&(s.len() as u16).to_be_bytes());
            o.extend_from_slice(s.as_bytes());
        }
        o
    }

    fn records(mut d: &[u8]) -> Vec<(u8, u8, String)> {
        let mut out = Vec::new();
        while d.len() >= 5 {
            let len = u16::from_be_bytes([d[3], d[4]]) as usize;
            out.push((d[1], d[2], String::from_utf8_lossy(&d[5..5 + len]).into_owned()));
            d = &d[5 + len..];
        }
        out
    }
}
