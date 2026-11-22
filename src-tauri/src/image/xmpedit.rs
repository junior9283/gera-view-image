//! Leitura e troca de título, descrição, autor e texto alternativo num pacote XMP, com tokenizador
//! XML (`quick-xml`) e resolução de namespace: vale o nome local e o endereço do namespace, não o
//! prefixo (`dc1:title` conta), e texto livre, comentário e CDATA nunca são tocados. O pacote é
//! de um arquivo não confiável: tamanho e número de eventos têm teto, e o tokenizador não expande
//! entidades. Pacote que não dá para ler ou editar com segurança volta `None`, e quem chama monta
//! um pacote novo só com os campos editados.
use super::metaedit::{clean, xml_unescape};
use crate::image::encode::xml_escape;
use quick_xml::{NsReader, events::Event, name::ResolveResult};
use std::ops::Range;

const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const NS_XML_LANG: &str = "xml:lang";
/// Teto do pacote lido ou regravado (acima disso, vira um pacote novo).
pub const MAX_XMP: usize = 8 << 20;
/// Teto de eventos do tokenizador.
const MAX_EVENTS: usize = 400_000;
/// Teto de itens `rdf:li` guardados por propriedade.
const MAX_ITEMS: usize = 64;

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

#[derive(Default)]
struct Item {
    span: Range<usize>,
    inner: Range<usize>,
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
}

#[derive(Default)]
struct Found {
    elements: Vec<Elem>,
    /// Propriedade escrita como atributo de outro elemento: (trecho, valor).
    attrs: Vec<(Range<usize>, String)>,
}

#[derive(Default)]
struct Scan {
    props: [Found; 4],
    /// Início da tag `</rdf:RDF>` (última) e o prefixo de `rdf` nela.
    rdf_end: Option<usize>,
    rdf_prefix: Option<String>,
}

/// `(nome, valor, trecho do atributo)` de cada atributo de uma tag; os trechos são relativos a `tag`.
fn attributes(tag: &str) -> Vec<(&str, &str, Range<usize>)> {
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
    while out.len() < 256 {
        i = skip_ws(i);
        let start = i;
        while b.get(i).is_some_and(|c| !c.is_ascii_whitespace() && !matches!(c, b'=' | b'/' | b'>')) {
            i += 1;
        }
        let name_end = i;
        if name_end == start {
            break;
        }
        i = skip_ws(i);
        if b.get(i) != Some(&b'=') {
            break;
        }
        i = skip_ws(i + 1);
        let Some(&q @ (b'"' | b'\'')) = b.get(i) else { break };
        let Some(len) = b.get(i + 1..).and_then(|r| r.iter().position(|&c| c == q)) else {
            break;
        };
        let (vs, ve) = (i + 1, i + 1 + len);
        if let (Some(n), Some(v)) = (tag.get(start..name_end), tag.get(vs..ve)) {
            out.push((n, v, start..ve + 1));
        }
        i = ve + 1;
    }
    out
}

fn prop_of(uri: Option<&str>, local: &str) -> Option<usize> {
    let uri = uri?;
    PROPS.iter().position(|p| p.ns == uri && p.local == local)
}

fn bound(r: &ResolveResult) -> Option<String> {
    match r {
        ResolveResult::Bound(ns) => Some(ns.as_ref().to_string()),
        _ => None,
    }
}

fn prefix_of(qname: &str) -> Option<&str> {
    qname.split_once(':').map(|(p, _)| p)
}

/// Percorre o pacote. `None` se não for XML bem formado, passar do teto ou não couber no tamanho.
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
        let uri = bound(&res);
        let after = r.buffer_position() as usize;
        let empty = matches!(ev, Event::Empty(_));
        match ev {
            Event::Eof => return Some(s),
            Event::End(e) => {
                if uri.as_deref() == Some(NS_RDF) && e.local_name().as_ref() == "RDF" {
                    s.rdf_end = Some(before);
                    s.rdf_prefix = prefix_of(e.name().as_ref()).map(str::to_string);
                }
            }
            Event::Start(e) | Event::Empty(e) => {
                let local = e.local_name().as_ref().to_string();
                let qname = e.name().as_ref().to_string();
                if let Some(i) = prop_of(uri.as_deref(), &local) {
                    let elem = if empty {
                        Elem { span: before..after, inner: after..after, qname, ..Elem::default() }
                    } else {
                        read_element(&mut r, xmp, before, after, qname)?
                    };
                    s.props[i].elements.push(elem);
                    continue;
                }
                let tag = xmp.get(before..after)?;
                for (name, value, span) in attributes(tag) {
                    let (res, local) = r.resolver().resolve_attribute(quick_xml::name::QName(name));
                    if let Some(i) = prop_of(bound(&res).as_deref(), local.as_ref()) {
                        let abs = before + span.start..before + span.end;
                        s.props[i].attrs.push((abs, xml_unescape(value)));
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
    // Item aberto: início, conteúdo, x-default, nome e profundidade em que abriu.
    let mut open: Option<(usize, usize, bool, String, usize)> = None;
    let mut events = 0usize;
    loop {
        events += 1;
        if events > MAX_EVENTS {
            return None;
        }
        let before = r.buffer_position() as usize;
        let (res, ev) = r.read_resolved_event().ok()?;
        let in_rdf = matches!(&res, ResolveResult::Bound(ns) if ns.as_ref() == NS_RDF);
        let after = r.buffer_position() as usize;
        let is_empty = matches!(ev, Event::Empty(_));
        match ev {
            Event::Start(e) | Event::Empty(e) => {
                let local = e.local_name().as_ref().to_string();
                let qn = e.name().as_ref().to_string();
                if in_rdf && local == "Alt" && !is_empty && elem.alt.is_none() {
                    elem.alt = Some((after, qn.clone()));
                }
                if in_rdf && local == "li" && open.is_none() && elem.items.len() < MAX_ITEMS {
                    let default_lang = attributes(xmp.get(before..after)?)
                        .iter()
                        .any(|(n, v, _)| *n == NS_XML_LANG && *v == "x-default");
                    if is_empty {
                        elem.items.push(Item { span: before..after, inner: after..after, default_lang, qname: qn });
                        continue;
                    }
                    open = Some((before, after, default_lang, qn, depth));
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
            let it = e.items.iter().find(|i| i.default_lang).unwrap_or(&e.items[0]);
            text_of(xmp, &it.inner)?
        } else {
            let parts: Vec<String> = e.items.iter().filter_map(|i| text_of(xmp, &i.inner)).filter(|t| !t.is_empty()).collect();
            parts.join(", ")
        }
    } else {
        clean(&found.attrs.first()?.1)
    };
    (!text.is_empty()).then_some(text)
}

/// Os quatro textos do pacote (título, descrição, autor, texto alternativo); tudo `None` se o
/// pacote não for XML legível.
pub fn read(xmp: &str) -> [Option<String>; 4] {
    let Some(s) = scan(xmp) else {
        return Default::default();
    };
    std::array::from_fn(|i| value_of(xmp, &PROPS[i], &s.props[i]))
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

/// Troca os campos de `values` (`Some("")` remove) e devolve o pacote editado, com o resto intacto.
/// Elementos e atributos da propriedade, em qualquer prefixo e quantidade, saem; em listas de
/// idioma só o `x-default` muda e as outras línguas ficam. `None` se o pacote não puder ser editado.
pub fn edit(xmp: &str, values: &[Option<String>; 4]) -> Option<String> {
    let s = scan(xmp)?;
    let rdf = s.rdf_prefix.as_deref().unwrap_or("rdf");
    let mut ops: Vec<(Range<usize>, String)> = Vec::new();
    let mut missing = String::new();
    let mut ns = String::new();
    for (i, p) in PROPS.iter().enumerate() {
        let Some(v) = values[i].as_deref().map(clean) else {
            continue;
        };
        let f = &s.props[i];
        ops.extend(f.attrs.iter().map(|(r, _)| (r.clone(), String::new())));
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
        // Lista de idiomas: só o `x-default` muda.
        let defaults: Vec<&Item> = first.items.iter().filter(|it| it.default_lang).collect();
        let others = first.items.len() - defaults.len();
        if v.is_empty() {
            if others == 0 {
                ops.push(whole(String::new()));
            } else {
                ops.extend(defaults.iter().map(|it| (it.span.clone(), String::new())));
            }
        } else if let Some((head, rest)) = defaults.split_first() {
            ops.push((head.span.clone(), item(prefix_of(&head.qname).unwrap_or(rdf), &v)));
            ops.extend(rest.iter().map(|it| (it.span.clone(), String::new())));
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
    // O resultado precisa continuar sendo XML legível e dentro do teto.
    scan(&out).map(|_| out)
}
