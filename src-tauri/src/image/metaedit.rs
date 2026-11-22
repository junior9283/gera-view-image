//! Título, descrição, autor e texto alternativo (Lote 9): gravação em XMP (`xmpedit.rs`), em
//! IPTC-IIM (2:05, 2:120, 2:80) e limpeza dos mesmos textos no EXIF (`exifscrub.rs`). O resto do
//! pacote, dos registros e do bloco é preservado.
//! Texto vem do usuário ou do arquivo: nada aqui entra em shell, e ninguém faz `unwrap` em fatia.
use super::{
    exifscrub::{self, Tags},
    xmpedit::{self, PROPS},
};
use crate::commands::describe::MetadataEdits;

/// Teto de caracteres de cada campo (uma edição maior é cortada, nunca recusada).
pub const MAX_CHARS: usize = 16_384;
/// Teto do texto que `xml_unescape` processa (o resto é descartado).
pub const MAX_UNESCAPE: usize = 1 << 16;
/// Teto do pacote XMP lido para as palavras-chave (a gravação tem o seu, em `xmpedit`).
pub const MAX_XMP_KEYWORDS: usize = 4 << 20;
/// Tetos em bytes no IPTC-IIM (o XMP guarda o texto inteiro).
const IIM_TITLE: usize = 256;
const IIM_AUTHOR: usize = 256;
const IIM_CAPTION: usize = 2000;
/// Teto de registros IIM lidos de um arquivo forjado.
const MAX_IIM_RECORDS: usize = 10_000;

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

    /// Valores na ordem de `xmpedit::PROPS`, já limpos.
    fn values(&self) -> [Option<String>; 4] {
        [&self.title, &self.description, &self.author, &self.alt_text].map(|v| v.as_deref().map(clean))
    }

    /// Os campos de `self` por cima dos de `base` (o que `self` não traz vem de `base`).
    pub fn over(&self, base: &MetadataEdits) -> MetadataEdits {
        MetadataEdits {
            title: self.title.clone().or_else(|| base.title.clone()),
            description: self.description.clone().or_else(|| base.description.clone()),
            author: self.author.clone().or_else(|| base.author.clone()),
            alt_text: self.alt_text.clone().or_else(|| base.alt_text.clone()),
        }
    }

    /// Só os campos que apagam (texto vazio): formatos sem XMP/IPTC não guardam o texto novo, mas
    /// apagar vale em qualquer um.
    pub fn only_clearing(&self) -> MetadataEdits {
        let keep = |v: &Option<String>| v.as_deref().filter(|t| clean(t).is_empty()).map(str::to_string);
        MetadataEdits {
            title: keep(&self.title),
            description: keep(&self.description),
            author: keep(&self.author),
            alt_text: keep(&self.alt_text),
        }
    }

    /// Marca (valor vazio) cada campo que `self` edita: o que já foi gravado no arquivo.
    pub fn as_cleared(&self) -> MetadataEdits {
        let mark = |v: &Option<String>| v.as_ref().map(|_| String::new());
        MetadataEdits {
            title: mark(&self.title),
            description: mark(&self.description),
            author: mark(&self.author),
            alt_text: mark(&self.alt_text),
        }
    }
}

// ---------- XMP ----------

/// Pacote XMP com os campos de `e` trocados, apagados (`Some("")`) ou acrescentados. Se o pacote
/// original não puder ser editado com segurança, sai um pacote novo só com os campos editados.
pub fn xmp_with_edits(orig: Option<&str>, e: &MetadataEdits) -> String {
    let values = e.values();
    orig.and_then(|x| xmpedit::edit(x, &values))
        .unwrap_or_else(|| xmpedit::fresh(&values))
}

/// Texto de uma propriedade do XMP (`dc:title`, `dc:description`, `dc:creator`,
/// `Iptc4xmpCore:AltTextAccessibility`).
pub fn xmp_text(xmp: &str, name: &str) -> Option<String> {
    let i = PROPS.iter().position(|p| p.name == name)?;
    let [a, b, c, d] = xmpedit::read(xmp);
    [a, b, c, d].into_iter().nth(i).flatten()
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
    let x = xmp.map(xmpedit::read).unwrap_or_default();
    let row = |rows: &[(String, String)], key: &str| {
        rows.iter()
            .find(|(k, v)| k == key && !v.trim().is_empty())
            .map(|(_, v)| clean(v))
            .filter(|v| !v.is_empty())
    };
    Texts {
        title: x[0].clone().or_else(|| row(iptc, "Title")),
        description: x[1].clone()
            .or_else(|| row(iptc, "Caption"))
            .or_else(|| row(exif, "ImageDescription")),
        author: x[2].clone()
            .or_else(|| row(iptc, "Creator"))
            .or_else(|| row(exif, "Artist")),
        alt_text: x[3].clone(),
    }
}

// ---------- EXIF ----------

/// Bloco EXIF sem o valor antigo dos campos editados em `e`: título (XPTitle, ImageTitle),
/// descrição (ImageDescription, XPComment, UserComment) e autor (Artist, XPAuthor, Photographer),
/// no IFD0, no IFD1 e no sub-IFD Exif. O resto do EXIF fica. `None` quando a limpeza não pode ser
/// feita com segurança: quem chama descarta o EXIF inteiro em vez de deixar o texto antigo passar.
pub fn exif_without_text(tiff: &[u8], e: &MetadataEdits) -> Option<Vec<u8>> {
    let (mut tiff_tags, mut exif_tags): (Vec<u16>, Vec<u16>) = (Vec::new(), Vec::new());
    if e.title.is_some() {
        tiff_tags.push(0x9C9B);
        exif_tags.push(0xA436);
    }
    if e.description.is_some() {
        tiff_tags.extend([0x010E, 0x9C9C]);
        exif_tags.push(0x9286);
    }
    if e.author.is_some() {
        tiff_tags.extend([0x013B, 0x9C9D]);
        exif_tags.push(0xA437);
    }
    if tiff_tags.is_empty() {
        return Some(tiff.to_vec());
    }
    exifscrub::scrub(tiff, &Tags { tiff: &tiff_tags, exif: &exif_tags })
}

// ---------- IPTC-IIM ----------

/// Texto de um registro 2:xx em UTF-8: o que já é UTF-8 válido fica, o resto é lido como Latin-1
/// (o conjunto antigo mais comum), porque o IIM gravado passa a declarar UTF-8 (1:90).
fn utf8_record(r: u8, n: u8, v: &[u8]) -> Vec<u8> {
    if r != 2 || n == 0 || std::str::from_utf8(v).is_ok() {
        return v.to_vec();
    }
    v.iter().map(|&b| char::from(b)).collect::<String>().into_bytes()
}

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
            records.push((r, n, utf8_record(r, n, &d[5..5 + len])));
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
        let orig = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"4\"><dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Velho</rdf:li></rdf:Alt></dc:title><dc:subject><rdf:Bag><rdf:li>k</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>";
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
        let orig = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description><dc:titleX>nao</dc:titleX></rdf:Description></rdf:RDF>";
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
        let x = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang=\"en\">One</rdf:li><rdf:li xml:lang=\"x-default\">Padr&#227;o &amp; &#x41;</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator><dc:description>simples</dc:description></rdf:Description></rdf:RDF>";
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
        let grande = format!(
            "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description><dc:creator><rdf:Seq>{}</rdf:Seq></dc:creator></rdf:Description></rdf:RDF>",
            "<rdf:li>x</rdf:li>".repeat(100_000)
        );
        assert!(xmp_text(&grande, "dc:creator").unwrap().len() < 1000);
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
        let out = exif_without_text(&orig, &e).unwrap();
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
    fn exif_sem_edicao_volta_igual_e_malformado_cai() {
        let orig = exif_com_textos();
        assert_eq!(exif_without_text(&orig, &MetadataEdits::default()), Some(orig.clone()));
        let e = MetadataEdits { author: Some("x".into()), ..Default::default() };
        for n in 0..orig.len() {
            let _ = exif_without_text(&orig[..n], &e);
        }
        let mut forjado = orig.clone();
        forjado[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(exif_without_text(&forjado, &e), None, "bloco ilegível: o EXIF inteiro cai");
    }

    #[test]
    fn xmp_remove_todas_as_ocorrencias_da_propriedade() {
        let dup = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description dc:creator=\"Atributo Velho\"><dc:creator><rdf:Seq><rdf:li>Velho 1</rdf:li></rdf:Seq></dc:creator></rdf:Description><rdf:Description><dc:creator><rdf:Seq><rdf:li>Velho 2</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF>";
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
        let xmp = format!("<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description><dc:title>{muitos}</dc:title></rdf:Description></rdf:RDF>");
        let _ = xmp_text(&xmp, "dc:title");
        let _ = texts_of(Some(&xmp), &[], &[]);
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
    }

    const NS_DECL: &str = "xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"";

    fn so_titulo(t: &str) -> MetadataEdits {
        MetadataEdits { title: Some(t.into()), ..Default::default() }
    }

    #[test]
    fn xmp_com_tags_emendadas_nao_panica_e_vira_pacote_novo() {
        // Pacote malformado: nenhuma busca de texto pode "emendar" os pedaços.
        for orig in ["<dc:ti<dc:title/>tle>x</dc:title>", "<dc:ti<dc:title>a</dc:title>tle>x</dc:title>", "<<dc:title/>>"] {
            let x = xmp_with_edits(Some(orig), &so_titulo("Novo"));
            assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("Novo"), "{orig}");
            assert!(!x.contains("tle>x"));
        }
    }

    #[test]
    fn xmp_atributo_com_tab_ou_quebra_de_linha_e_outro_prefixo_tambem_saem() {
        let orig = format!(
            "<rdf:RDF {NS_DECL} xmlns:d1=\"http://purl.org/dc/elements/1.1/\"><rdf:Description\n\tdc:creator\t=\n'Velho Atributo' d1:title=\"Velho Titulo\"><d1:description><rdf:Alt><rdf:li xml:lang=\"x-default\">Velha Desc</rdf:li></rdf:Alt></d1:description></rdf:Description></rdf:RDF>"
        );
        assert_eq!(xmp_text(&orig, "dc:title").as_deref(), Some("Velho Titulo")); // outro prefixo é lido
        assert_eq!(xmp_text(&orig, "dc:creator").as_deref(), Some("Velho Atributo"));
        let e = MetadataEdits {
            title: Some("T".into()),
            description: Some("D".into()),
            author: Some("A".into()),
            ..Default::default()
        };
        let x = xmp_with_edits(Some(&orig), &e);
        assert!(!x.contains("Velh"), "{x}");
        assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("T"));
        assert_eq!(xmp_text(&x, "dc:description").as_deref(), Some("D"));
        assert_eq!(xmp_text(&x, "dc:creator").as_deref(), Some("A"));
    }

    #[test]
    fn xmp_nao_mexe_em_texto_livre_comentario_nem_cdata() {
        let orig = format!(
            "<rdf:RDF {NS_DECL}><!-- <dc:title>comentario</dc:title> --><rdf:Description><dc:subject>texto dc:title=\"x\" <![CDATA[<dc:title>cdata</dc:title>]]></dc:subject></rdf:Description></rdf:RDF>"
        );
        let x = xmp_with_edits(Some(&orig), &so_titulo("Novo"));
        for guardado in ["<dc:title>comentario</dc:title>", "texto dc:title=\"x\"", "<![CDATA[<dc:title>cdata</dc:title>]]>"] {
            assert!(x.contains(guardado), "{guardado} sumiu:\n{x}");
        }
        assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("Novo"));
    }

    #[test]
    fn xmp_titulo_em_outros_idiomas_sobrevive_a_edicao_do_padrao() {
        let orig = format!(
            "<rdf:RDF {NS_DECL}><rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang=\"en\">English</rdf:li><rdf:li xml:lang=\"x-default\">Velho</rdf:li><rdf:li xml:lang=\"fr\">Français</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF>"
        );
        let x = xmp_with_edits(Some(&orig), &so_titulo("Novo"));
        assert!(x.contains("English") && x.contains("Français") && !x.contains("Velho"));
        assert_eq!(xmp_text(&x, "dc:title").as_deref(), Some("Novo"));
        // sem x-default: entra um novo, e as traduções ficam
        let sem = orig.replace("x-default", "de");
        let y = xmp_with_edits(Some(&sem), &so_titulo("Padrão"));
        assert!(y.contains("English") && y.contains("Velho") && xmp_text(&y, "dc:title").as_deref() == Some("Padrão"));
        // apagar tira só o padrão enquanto houver outras línguas
        let z = xmp_with_edits(Some(&orig), &so_titulo(""));
        assert!(z.contains("English") && !z.contains("Velho"));
        assert_eq!(xmp_text(&z, "dc:title").as_deref(), Some("English"));
    }

    #[test]
    fn xmp_gigante_ou_ilegivel_vira_pacote_novo_sem_travar() {
        let t = std::time::Instant::now();
        let grande = format!("<rdf:RDF {NS_DECL}><rdf:Description>{}</rdf:Description></rdf:RDF>", "<a/>".repeat(3 << 20));
        let x = xmp_with_edits(Some(&grande), &so_titulo("Novo"));
        assert!(x.len() < 2000 && xmp_text(&x, "dc:title").as_deref() == Some("Novo"));
        assert!(t.elapsed() < std::time::Duration::from_secs(10), "{:?}", t.elapsed());
    }

    #[test]
    fn iim_latin1_antigo_e_convertido_antes_de_declarar_utf8() {
        // 2:116 (copyright) em Latin-1 ("Fundação" com ç e ã em ISO-8859-1) e 2:25 já em UTF-8.
        let mut orig = vec![0x1C, 2, 116, 0, 8];
        orig.extend_from_slice(b"Funda\xE7\xE3o");
        orig.extend(iim(&[(2, 25, "coração")]));
        let out = iim_with_edits(Some(&orig), &so_titulo("T"));
        let recs = records(&out);
        assert!(recs.contains(&(2, 116, "Fundação".to_string())), "{recs:?}");
        assert!(recs.contains(&(2, 25, "coração".to_string())));
        assert_eq!(recs[0], (1, 90, "\u{1b}%G".to_string()));
    }

    #[test]
    fn editados_sem_valor_novo_so_apagam_e_over_mescla() {
        let e = MetadataEdits { title: Some("novo".into()), author: Some("  ".into()), ..Default::default() };
        let c = e.only_clearing();
        assert_eq!((c.title, c.author.as_deref()), (None, Some("  ")));
        let base = MetadataEdits { description: Some(String::new()), title: Some(String::new()), ..Default::default() };
        let m = e.over(&base);
        assert_eq!((m.title.as_deref(), m.description.as_deref()), (Some("novo"), Some("")));
        assert_eq!(e.as_cleared().title.as_deref(), Some(""));
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
