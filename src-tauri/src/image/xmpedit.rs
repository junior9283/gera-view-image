//! Leitura e troca de título, descrição, autor e texto alternativo num pacote XMP, com tokenizador
//! XML (`quick-xml`) e resolução de namespace: vale o nome local e o endereço do namespace, não o
//! prefixo (`dc1:title` conta), e texto livre, comentário e CDATA nunca são tocados. O pacote é
//! de um arquivo não confiável: tamanho, eventos, itens e atributos têm teto, e o tokenizador não
//! expande entidades. Na leitura um teto só trunca; na edição, qualquer teto atingido, pacote
//! ilegível ou resultado que não confira com o pedido volta `None`, e quem chama monta um pacote
//! novo (e avisa o usuário).
use super::metaedit::{clean, xml_unescape};
use crate::image::encode::xml_escape;
use quick_xml::{NsReader, events::Event, name::QName, name::ResolveResult};
use std::ops::Range;

const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const NS_XML_LANG: &str = "xml:lang";
/// Teto do pacote lido ou regravado (acima disso, vira um pacote novo).
pub const MAX_XMP: usize = 8 << 20;
/// Teto de eventos do tokenizador.
const MAX_EVENTS: usize = 400_000;
/// Teto de itens `rdf:li` guardados por propriedade.
const MAX_ITEMS: usize = 64;
/// Teto de atributos lidos por tag.
const MAX_ATTRS: usize = 256;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    LangAlt,
    Seq,
}

pub struct Prop {
    /// Nome qualificado de referência (`dc:title`), como o resto do código o chama.
    pub name: &'static str,
    pub prefix: &'static str,
    pub local: &'static str,
    pub ns: &'static str,
    pub kind: Kind,
}

/// Campos editáveis, na ordem de `MetadataEdits`: título, descrição, autor, texto alternativo.
pub const PROPS: [Prop; 4] = [
    Prop { name: "dc:title", prefix: "dc", local: "title", ns: "http://purl.org/dc/elements/1.1/", kind: Kind::LangAlt },
    Prop { name: "dc:description", prefix: "dc", local: "description", ns: "http://purl.org/dc/elements/1.1/", kind: Kind::LangAlt },
    Prop { name: "dc:creator", prefix: "dc", local: "creator", ns: "http://purl.org/dc/elements/1.1/", kind: Kind::Seq },
    Prop {
        name: "Iptc4xmpCore:AltTextAccessibility",
        prefix: "Iptc4xmpCore",
        local: "AltTextAccessibility",
        ns: "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
        kind: Kind::LangAlt,
    },
];

/// Cópias de um campo (índice de `PROPS`) em outros esquemas: o EXIF repetido dentro do XMP. Saem
/// quando o campo é editado, senão guardariam o texto antigo.
const ALIASES: [(&str, &str, usize); 5] = [
    ("http://cipa.jp/exif/1.0/", "ImageTitle", 0),
    ("http://ns.adobe.com/tiff/1.0/", "ImageDescription", 1),
    ("http://ns.adobe.com/exif/1.0/", "UserComment", 1),
    ("http://ns.adobe.com/tiff/1.0/", "Artist", 2),
    ("http://cipa.jp/exif/1.0/", "Photographer", 2),
];

#[derive(Default)]
struct Item {
    span: Range<usize>,
    inner: Range<usize>,
    /// Sem `xml:lang` ou com `x-default` (sem diferenciar maiúsculas): o item "padrão".
    default_lang: bool,
    /// Nome qualificado da tag (`rdf:li`).
    qname: String,
}

#[derive(Default)]
struct Elem {
    span: Range<usize>,
    inner: Range<usize>,
    qname: String,
    items: Vec<Item>,
    /// Onde começa o conteúdo de `rdf:Alt` e o nome da tag, para acrescentar um item.
    alt: Option<(usize, String)>,
    /// Itens ou atributos além do teto ficaram sem ler.
    truncated: bool,
}

#[derive(Default)]
struct Found {
    elements: Vec<Elem>,
    /// Propriedade escrita como atributo de outro elemento: (trecho, valor).
    attrs: Vec<(Range<usize>, String)>,
    /// Trechos das cópias em outros esquemas (`ALIASES`).
    aliases: Vec<Range<usize>>,
}

#[derive(Default)]
struct Scan {
    props: [Found; 4],
    /// Início da tag `</rdf:RDF>` (última) e o prefixo de `rdf` nela.
    rdf_end: Option<usize>,
    rdf_prefix: Option<String>,
    /// Algum teto cortou a leitura: serve para ler, não para editar.
    truncated: bool,
}

type Attr<'a> = (&'a str, &'a str, Range<usize>);

/// Atributos de uma tag (nome, valor, trecho relativo à tag) e se a leitura foi até o fim da tag.
fn attributes(tag: &str) -> (Vec<Attr<'_>>, bool) {
    let b = tag.as_bytes();
    let mut out = Vec::new();
    let skip_ws = |mut i: usize| {
        while b.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        i
    };
    // Pula `<` e o nome do elemento.
    let mut i = 1;
    while b.get(i).is_some_and(|c| !c.is_ascii_whitespace() && !matches!(c, b'/' | b'>')) {
        i += 1;
    }
    while out.len() < MAX_ATTRS {
        i = skip_ws(i);
        let start = i;
        while b.get(i).is_some_and(|c| !c.is_ascii_whitespace() && !matches!(c, b'=' | b'/' | b'>')) {
            i += 1;
        }
        let name_end = i;
        if name_end == start {
            return (out, matches!(b.get(i), None | Some(b'/' | b'>')));
        }
        i = skip_ws(i);
        if b.get(i) != Some(&b'=') {
            return (out, false);
        }
        i = skip_ws(i + 1);
        let Some(&q @ (b'"' | b'\'')) = b.get(i) else {
            return (out, false);
        };
        let Some(len) = b.get(i + 1..).and_then(|r| r.iter().position(|&c| c == q)) else {
            return (out, false);
        };
        let (vs, ve) = (i + 1, i + 1 + len);
        if let (Some(n), Some(v)) = (tag.get(start..name_end), tag.get(vs..ve)) {
            out.push((n, v, start..ve + 1));
        }
        i = ve + 1;
    }
    (out, false)
}

/// O item é o "padrão": sem `xml:lang`, ou `x-default` em qualquer caixa (valor desescapado).
fn is_default(attrs: &[Attr]) -> bool {
    attrs
        .iter()
        .find(|(n, ..)| *n == NS_XML_LANG)
        .is_none_or(|(_, v, _)| xml_unescape(v).trim().eq_ignore_ascii_case("x-default"))
}

fn prop_of(uri: Option<&str>, local: &str) -> Option<usize> {
    let uri = uri?;
    PROPS.iter().position(|p| p.ns == uri && p.local == local)
}

fn alias_of(uri: Option<&str>, local: &str) -> Option<usize> {
    let uri = uri?;
    ALIASES.iter().find(|a| a.0 == uri && a.1 == local).map(|a| a.2)
}

fn ns_of<'a>(r: &'a ResolveResult) -> Option<&'a str> {
    match r {
        ResolveResult::Bound(ns) => Some(ns.as_ref()),
        _ => None,
    }
}

fn prefix_of(qname: &str) -> Option<&str> {
    qname.split_once(':').map(|(p, _)| p)
}

/// Percorre o pacote. `None` se não for XML bem formado, passar do teto de tamanho ou de eventos.
fn scan(xmp: &str) -> Option<Scan> {
    if xmp.len() > MAX_XMP {
        return None;
    }
    let mut r = NsReader::from_str(xmp);
    let mut s = Scan::default();
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_EVENTS {
            return None;
        }
        let before = r.buffer_position() as usize;
        let (res, ev) = r.read_resolved_event().ok()?;
        let is_rdf = ns_of(&res) == Some(NS_RDF);
        let (prop, alias) = match &ev {
            Event::Start(e) | Event::Empty(e) => {
                let (uri, local) = (ns_of(&res), e.local_name());
                (prop_of(uri, local.as_ref()), alias_of(uri, local.as_ref()))
            }
            _ => (None, None),
        };
        let after = r.buffer_position() as usize;
        let empty = matches!(ev, Event::Empty(_));
        match ev {
            Event::Eof => return Some(s),
            Event::End(e) => {
                if is_rdf && e.local_name().as_ref() == "RDF" {
                    s.rdf_end = Some(before);
                    s.rdf_prefix = prefix_of(e.name().as_ref()).map(str::to_string);
                }
            }
            Event::Start(e) | Event::Empty(e) => {
                if let Some(i) = prop.or(alias) {
                    let qname = e.name().as_ref().to_string();
                    let elem = if empty {
                        Elem { span: before..after, inner: after..after, qname, ..Elem::default() }
                    } else {
                        read_element(&mut r, xmp, before, after, qname)?
                    };
                    if prop.is_some() {
                        s.truncated |= elem.truncated;
                        s.props[i].elements.push(elem);
                    } else {
                        s.props[i].aliases.push(elem.span);
                    }
                    continue;
                }
                let (attrs, complete) = attributes(xmp.get(before..after)?);
                s.truncated |= !complete;
                for (name, value, span) in attrs {
                    let (res, local) = r.resolver().resolve_attribute(QName(name));
                    let abs = before + span.start..before + span.end;
                    if let Some(i) = prop_of(ns_of(&res), local.as_ref()) {
                        s.props[i].attrs.push((abs, xml_unescape(value)));
                    } else if let Some(i) = alias_of(ns_of(&res), local.as_ref()) {
                        s.props[i].aliases.push(abs);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Lê o conteúdo de um elemento de propriedade (depois da tag de abertura) até o fim dele.
fn read_element(r: &mut NsReader<&[u8]>, xmp: &str, start: usize, content: usize, qname: String) -> Option<Elem> {
    let mut elem = Elem { qname, ..Elem::default() };
    let mut depth = 1usize;
    // Item aberto: início, conteúdo, padrão, nome e profundidade em que abriu.
    let mut open: Option<(usize, usize, bool, String, usize)> = None;
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_EVENTS {
            return None;
        }
        let before = r.buffer_position() as usize;
        let (res, ev) = r.read_resolved_event().ok()?;
        let in_rdf = ns_of(&res) == Some(NS_RDF);
        let after = r.buffer_position() as usize;
        let is_empty = matches!(ev, Event::Empty(_));
        match ev {
            Event::Start(e) | Event::Empty(e) => {
                let local = e.local_name();
                if in_rdf && local.as_ref() == "Alt" && !is_empty && elem.alt.is_none() {
                    elem.alt = Some((after, e.name().as_ref().to_string()));
                }
                if in_rdf && local.as_ref() == "li" && open.is_none() {
                    if elem.items.len() >= MAX_ITEMS {
                        elem.truncated = true;
                    } else {
                        let (attrs, complete) = attributes(xmp.get(before..after)?);
                        elem.truncated |= !complete;
                        let default_lang = is_default(&attrs);
                        let qn = e.name().as_ref().to_string();
                        if is_empty {
                            elem.items.push(Item { span: before..after, inner: after..after, default_lang, qname: qn });
                            continue;
                        }
                        open = Some((before, after, default_lang, qn, depth));
                    }
                }
                if !is_empty {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    elem.span = start..after;
                    elem.inner = content..before;
                    return Some(elem);
                }
                if open.as_ref().is_some_and(|o| o.4 == depth)
                    && let Some((s, c, d, qn, _)) = open.take()
                {
                    elem.items.push(Item { span: s..after, inner: c..before, default_lang: d, qname: qn });
                }
            }
            Event::Eof => return None,
            _ => {}
        }
    }
}

/// O item que a leitura mostra e que a edição troca: o primeiro padrão, ou o primeiro item.
fn shown(items: &[Item]) -> Option<&Item> {
    items.iter().find(|i| i.default_lang).or(items.first())
}

/// Texto do conteúdo: sem marcação dentro (CDATA e elementos aninhados não valem), sem entidades.
fn text_of(xmp: &str, r: &Range<usize>) -> Option<String> {
    let t = xmp.get(r.clone())?;
    (!t.contains('<')).then(|| clean(&xml_unescape(t.trim())))
}

fn value_of(xmp: &str, prop: &Prop, found: &Found) -> Option<String> {
    let text = if let Some(e) = found.elements.first() {
        if e.items.is_empty() {
            text_of(xmp, &e.inner)?
        } else if prop.kind == Kind::LangAlt {
            text_of(xmp, &shown(&e.items)?.inner)?
        } else {
            let parts: Vec<String> = e.items.iter().filter_map(|i| text_of(xmp, &i.inner)).filter(|t| !t.is_empty()).collect();
            parts.join(", ")
        }
    } else {
        clean(&found.attrs.first()?.1)
    };
    (!text.is_empty()).then_some(text)
}

fn values_of(xmp: &str, s: &Scan) -> [Option<String>; 4] {
    std::array::from_fn(|i| value_of(xmp, &PROPS[i], &s.props[i]))
}

/// Um BOM no começo do pacote sai antes de ler ou editar (os deslocamentos valem para o texto sem ele).
fn no_bom(xmp: &str) -> &str {
    xmp.strip_prefix('\u{FEFF}').unwrap_or(xmp)
}

/// Os quatro textos do pacote (título, descrição, autor, texto alternativo); tudo `None` se o
/// pacote não for XML legível. Na leitura os tetos só truncam.
pub fn read(xmp: &str) -> [Option<String>; 4] {
    let xmp = no_bom(xmp);
    scan(xmp).map_or_else(Default::default, |s| values_of(xmp, &s))
}

fn item(prefix: &str, text: &str) -> String {
    format!("<{prefix}:li xml:lang=\"x-default\">{}</{prefix}:li>", xml_escape(text))
}

fn element(p: &Prop, qname: &str, rdf: &str, text: &str) -> String {
    let v = xml_escape(text);
    match p.kind {
        Kind::LangAlt => format!("<{qname}><{rdf}:Alt>{}</{rdf}:Alt></{qname}>", item(rdf, text)),
        Kind::Seq => format!("<{qname}><{rdf}:Seq><{rdf}:li>{v}</{rdf}:li></{rdf}:Seq></{qname}>"),
    }
}

/// Pacote novo só com os campos não vazios de `values`.
pub fn fresh(values: &[Option<String>; 4]) -> String {
    let mut ns = String::new();
    let mut body = String::new();
    for (p, v) in PROPS.iter().zip(values) {
        let Some(v) = v.as_deref().map(clean).filter(|v| !v.is_empty()) else {
            continue;
        };
        let decl = format!(" xmlns:{}=\"{}\"", p.prefix, p.ns);
        if !ns.contains(&decl) {
            ns.push_str(&decl);
        }
        body.push_str(&element(p, &format!("{}:{}", p.prefix, p.local), "rdf", &v));
    }
    format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"{NS_RDF}\"><rdf:Description rdf:about=\"\"{ns}>{body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
}

/// Troca os campos de `values` (`Some("")` apaga a propriedade, em todas as línguas) e devolve o pacote editado, com o
/// resto intacto. Elementos e atributos da propriedade, em qualquer prefixo e quantidade, saem; em
/// listas de idioma a edição muda só o item padrão (sem `xml:lang` ou `x-default`) e as cópias dele;
/// as outras línguas ficam. `None` se o pacote não puder ser editado com segurança: ilegível, grande demais, lido
/// só em parte ou com resultado diferente do pedido.
pub fn edit(xmp: &str, values: &[Option<String>; 4]) -> Option<String> {
    let xmp = no_bom(xmp);
    let s = scan(xmp)?;
    if s.truncated {
        return None;
    }
    let rdf = s.rdf_prefix.as_deref().unwrap_or("rdf");
    let mut ops: Vec<(Range<usize>, String)> = Vec::new();
    let mut missing = String::new();
    let mut ns = String::new();
    for (i, p) in PROPS.iter().enumerate() {
        let Some(v) = values[i].as_deref().map(clean) else {
            continue;
        };
        let f = &s.props[i];
        ops.extend(f.attrs.iter().map(|(r, _)| r).chain(&f.aliases).map(|r| (r.clone(), String::new())));
        let Some(first) = f.elements.first() else {
            if !v.is_empty() {
                let decl = format!(" xmlns:{}=\"{}\"", p.prefix, p.ns);
                if !ns.contains(&decl) {
                    ns.push_str(&decl);
                }
                missing.push_str(&element(p, &format!("{}:{}", p.prefix, p.local), rdf, &v));
            }
            continue;
        };
        ops.extend(f.elements.iter().skip(1).map(|e| (e.span.clone(), String::new())));
        let whole = |new: String| (first.span.clone(), new);
        if p.kind == Kind::Seq || first.items.is_empty() {
            ops.push(whole(if v.is_empty() { String::new() } else { element(p, &first.qname, rdf, &v) }));
            continue;
        }
        if v.is_empty() {
            // Apagar vale para todas as línguas: um item que ficasse voltaria a ser exibido.
            ops.push(whole(String::new()));
        } else if let Some(head) = first.items.iter().find(|it| it.default_lang) {
            ops.push((head.span.clone(), item(prefix_of(&head.qname).unwrap_or(rdf), &v)));
            // Saem os outros padrões e as cópias do texto trocado (o XMP Toolkit repete o padrão em en-US).
            let old = text_of(xmp, &head.inner);
            let copy = |it: &&Item| it.default_lang || (old.is_some() && text_of(xmp, &it.inner) == old);
            let rest = first.items.iter().filter(|it| it.span != head.span);
            ops.extend(rest.filter(copy).map(|it| (it.span.clone(), String::new())));
        } else if let Some((at, qn)) = &first.alt {
            ops.push((*at..*at, item(prefix_of(qn).unwrap_or(rdf), &v)));
        } else {
            ops.push(whole(element(p, &first.qname, rdf, &v)));
        }
    }
    if !missing.is_empty() {
        let at = s.rdf_end?;
        ops.push((at..at, format!("<{rdf}:Description {rdf}:about=\"\"{ns}>{missing}</{rdf}:Description>")));
    }
    ops.sort_by_key(|(r, _)| (r.start, r.end));
    let mut out = String::with_capacity(xmp.len() + 256);
    let mut pos = 0usize;
    for (r, new) in &ops {
        if r.start < pos {
            return None; // trechos que se cruzam: não mexe
        }
        out.push_str(xmp.get(pos..r.start)?);
        out.push_str(new);
        pos = r.end;
    }
    out.push_str(xmp.get(pos..)?);
    // Pós-condição: o resultado é XML legível e relido dá o que foi pedido (e só isso).
    let after = scan(&out)?;
    let (was, now) = (values_of(xmp, &s), values_of(&out, &after));
    let ok = (0..4).all(|i| match values[i].as_deref().map(clean) {
        None => now[i] == was[i],
        Some(_) if !after.props[i].aliases.is_empty() => false,
        Some(v) if v.is_empty() => now[i].is_none(),
        Some(v) => now[i].as_deref() == Some(v.as_str()),
    });
    ok.then_some(out)
}
