//! Metadados para o inspetor: geral, EXIF (rótulos legíveis), IPTC (APP13), GPS e palavras-chave.
//! Tudo é tolerante: bloco corrompido vira lista vazia, nunca erro nem pânico.
use super::{
    decode::Decoded,
    formatinfo::{self, Section},
    makernote::{self, Maker},
    metaedit::{self, Cleared, Texts, xml_unescape},
};
use crate::error::AppResult;
use ::image::{ImageDecoder, ImageFormat, ImageReader};
use exif::{Context, In, Reader, Tag, Value};
use rayon::prelude::*;
use serde::Serialize;
use std::{
    io::Cursor,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct General {
    pub width: u32,
    pub height: u32,
    pub dpi: Option<(f32, f32)>,
    /// `RGB` ou `Gray`.
    pub color_model: String,
    /// Nome do perfil ICC embutido (tag `desc`).
    pub profile: Option<String>,
    /// Bits por canal.
    pub depth: u8,
    pub has_alpha: bool,
    pub file_size: u64,
    /// ISO 8601 em UTC; `None` quando o sistema de arquivos não informa.
    pub created: Option<String>,
    pub modified: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Gps {
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<f64>,
}

/// Parte dos metadados que vem dos blocos EXIF/IPTC/XMP do arquivo.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Blocks {
    pub exif: Vec<(String, String)>,
    pub iptc: Vec<(String, String)>,
    pub gps: Option<Gps>,
    pub keywords: Vec<String>,
    /// Aba do fabricante (MakerNote) e dados da lente.
    pub maker: Option<Maker>,
    pub lens: Vec<(String, String)>,
    /// Título, descrição, autor e texto alternativo como estão no arquivo.
    pub texts: Texts,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub general: General,
    pub exif: Vec<(String, String)>,
    pub iptc: Vec<(String, String)>,
    pub gps: Option<Gps>,
    pub keywords: Vec<String>,
    /// Abas por formato: `tiff`, `jfif`, `png`, `gif` ou `heif` (só as que o arquivo tem).
    pub sections: Vec<Section>,
    pub maker: Option<Maker>,
    pub lens: Vec<(String, String)>,
    pub texts: Texts,
    pub carried: Carried,
}

/// Blocos do arquivo que uma gravação levaria (para avisar antes o que o formato não guarda).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Carried {
    pub exif: bool,
    /// XMP ou IPTC.
    pub text: bool,
}

/// Lê os metadados de `path`. `decoded` traz EXIF, ICC e DPI já extraídos na abertura.
pub fn read_metadata(path: &Path, decoded: &Decoded) -> AppResult<Metadata> {
    read_metadata_with(path, decoded, &Cleared::default())
}

/// Como `read_metadata`, sem o que `cleared` marca do EXIF (já gravado no arquivo, mas ainda presente
/// no EXIF guardado na abertura). EXIF que não dá para limpar não é mostrado.
pub fn read_metadata_with(path: &Path, decoded: &Decoded, cleared: &Cleared) -> AppResult<Metadata> {
    let exif = decoded.exif.as_deref().and_then(|e| {
        if cleared.text.is_empty() && !cleared.keywords {
            Some(e.to_vec())
        } else {
            metaedit::exif_without_text(e, &cleared.text, cleared.keywords)
        }
    });
    let exif = exif.as_deref();
    let bytes = crate::fsio::read_regular(path)?;
    let fs_meta = std::fs::metadata(path)?;
    let (width, height) = decoded
        .frames
        .first()
        .map_or((0, 0), |f| (f.width(), f.height()));
    let (color_model, depth, has_alpha) = color_info(&bytes, decoded);
    let general = General {
        width,
        height,
        dpi: decoded.dpi,
        color_model,
        profile: decoded.icc.as_deref().and_then(icc_description),
        depth,
        has_alpha,
        file_size: fs_meta.len(),
        created: fs_meta.created().ok().map(iso_utc),
        modified: fs_meta
            .modified()
            .map(iso_utc)
            .unwrap_or_else(|_| iso_utc(UNIX_EPOCH)),
    };
    let b = parse_blocks(&bytes, exif);
    Ok(Metadata {
        general,
        exif: b.exif,
        iptc: b.iptc,
        gps: b.gps,
        keywords: b.keywords,
        sections: formatinfo::sections(&bytes, exif),
        maker: b.maker,
        lens: b.lens,
        texts: b.texts,
        carried: Carried { exif: exif.is_some(), text: has_text(&bytes) },
    })
}

/// Textos (título, descrição, autor, texto alternativo) que o IPTC e o EXIF dizem, sem o XMP: o que
/// um pacote XMP novo deve levar dos campos que o usuário não editou.
pub fn known_texts(iim: Option<&[u8]>, exif_tiff: Option<&[u8]>) -> [Option<String>; 4] {
    let mut iptc = Vec::new();
    if let Some(d) = iim {
        parse_iim(d, &mut iptc, &mut Vec::new());
    }
    let t = metaedit::texts_of(None, &iptc, &parse_blocks(&[], exif_tiff).exif);
    [t.title, t.description, t.author, t.alt_text]
}

/// Textos que uma página tem (IPTC-IIM, XMP e EXIF dela) e se ela tem palavras-chave: onde uma
/// edição de texto ou de palavras-chave troca o valor numa página que não é a primeira.
pub fn page_texts(iim: Option<&[u8]>, xmp: Option<&str>, exif_tiff: Option<&[u8]>) -> (metaedit::Texts, bool) {
    let (mut iptc, mut keywords) = (Vec::new(), Vec::new());
    if let Some(d) = iim {
        parse_iim(d, &mut iptc, &mut keywords);
    }
    let has_keywords = !keywords.is_empty() || xmp.is_some_and(|x| !xmp_keywords(x).is_empty());
    (metaedit::texts_of(xmp, &iptc, &parse_blocks(&[], exif_tiff).exif), has_keywords)
}

/// Extrai EXIF (bloco TIFF cru), GPS, IPTC e palavras-chave (IPTC + XMP `dc:subject`).
pub fn parse_blocks(file: &[u8], exif_tiff: Option<&[u8]>) -> Blocks {
    let mut out = Blocks::default();
    if let Some(Ok(exif)) = exif_tiff.map(|e| Reader::new().read_raw(e.to_vec())) {
        for f in exif.fields().filter(|f| f.ifd_num == In::PRIMARY) {
            if f.tag.0 == Context::Gps || f.tag == Tag::MakerNote {
                continue;
            }
            let value = match &f.value {
                // O crate mostra o ASCII com todo byte fora do básico escapado (`Jos\xc3\xa9`).
                Value::Ascii(v) => {
                    let parts: Vec<String> = v.iter().map(|b| metaedit::text_bytes(b).trim().to_string()).filter(|s| !s.is_empty()).collect();
                    parts.join(", ")
                }
                _ => unquote(&f.display_value().with_unit(&exif).to_string()),
            };
            out.exif.push((f.tag.to_string(), value));
        }
        out.gps = gps_of(&exif);
        out.maker = makernote::maker_of(&exif);
        out.lens = makernote::lens_rows(&exif, out.maker.as_ref());
    }
    let (iim, xmp) = file_iim_xmp(file);
    let mut keywords = Vec::new();
    if let Some(iim) = iim {
        parse_iim(&iim, &mut out.iptc, &mut keywords);
    }
    for k in xmp.as_deref().map(xmp_keywords).unwrap_or_default() {
        if !keywords.contains(&k) {
            keywords.push(k);
        }
    }
    out.keywords = keywords;
    out.texts = metaedit::texts_of(xmp.as_deref(), &out.iptc, &out.exif);
    out
}

/// `"abc"` vira `abc`; valores com várias strings ficam como o crate os mostra.
fn unquote(v: &str) -> String {
    match v.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        Some(inner) if !inner.contains("\", \"") => inner.to_string(),
        _ => v.to_string(),
    }
}

fn gps_of(exif: &exif::Exif) -> Option<Gps> {
    let dms = |tag| match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Rational(v) if v.len() >= 3 => {
            Some(v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0)
        }
        _ => None,
    };
    let reference = |tag| match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(v) => v.first()?.first().copied(),
        _ => None,
    };
    let mut lat = dms(Tag::GPSLatitude)?;
    let mut lon = dms(Tag::GPSLongitude)?;
    if !lat.is_finite() || !lon.is_finite() {
        return None;
    }
    if reference(Tag::GPSLatitudeRef) == Some(b'S') {
        lat = -lat;
    }
    if reference(Tag::GPSLongitudeRef) == Some(b'W') {
        lon = -lon;
    }
    let below = matches!(
        exif.get_field(Tag::GPSAltitudeRef, In::PRIMARY).map(|f| &f.value),
        Some(Value::Byte(b)) if b.first() == Some(&1)
    );
    // A altitude é opcional: sem ela a localização continua valendo.
    let alt = match exif.get_field(Tag::GPSAltitude, In::PRIMARY).map(|f| &f.value) {
        Some(Value::Rational(v)) => v.first().map(|r| r.to_f64()),
        _ => None,
    }
    .filter(|a| a.is_finite())
    .map(|a| if below { -a } else { a });
    Some(Gps { lat, lon, alt })
}

/// Segmentos APP de um JPEG: `(marcador, payload)`, parando no início dos dados (SOS).
pub(super) fn jpeg_segments(b: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
    let mut pos = 2usize;
    std::iter::from_fn(move || {
        loop {
            if b.get(pos)? != &0xFF {
                return None;
            }
            let marker = *b.get(pos + 1)?;
            if marker == 0xFF {
                pos += 1; // preenchimento
                continue;
            }
            if marker == 0xDA || marker == 0xD9 {
                return None;
            }
            if (0xD0..=0xD8).contains(&marker) || marker == 0x01 {
                pos += 2;
                continue;
            }
            let len = u16::from_be_bytes([*b.get(pos + 2)?, *b.get(pos + 3)?]) as usize;
            let payload = b.get(pos + 4..pos + 2 + len)?;
            pos += 2 + len;
            return Some((marker, payload));
        }
    })
}

/// IPTC-IIM e XMP crus do arquivo, para o inspetor e para levar ao arquivo salvo.
/// JPEG: APP13 (recurso 0x0404) e APP1 com o XMP estendido reunido. TIFF: tags 33723 e 700.
/// PNG e WebP: só XMP. Outros formatos: `(None, None)`.
pub fn file_iim_xmp(file: &[u8]) -> (Option<Vec<u8>>, Option<String>) {
    use super::container::{TAG_IPTC, TAG_XMP, tiff_tag};
    let text = |b: Vec<u8>| String::from_utf8_lossy(&b).into_owned();
    if file.starts_with(&[0xFF, 0xD8]) {
        jpeg_iim_xmp(file)
    } else if file.starts_with(b"II*\0") || file.starts_with(b"MM\0*") {
        (tiff_tag(file, TAG_IPTC), tiff_tag(file, TAG_XMP).map(text))
    } else {
        let xmp = ImageReader::new(Cursor::new(file))
            .with_guessed_format()
            .ok()
            .filter(|r| matches!(r.format(), Some(ImageFormat::Png | ImageFormat::WebP)))
            .and_then(|r| r.into_decoder().ok())
            .and_then(|mut d| d.xmp_metadata().ok().flatten());
        (None, xmp.map(text))
    }
}

/// O arquivo tem XMP ou IPTC. Nos contêineres que o app não lê nem regrava (HEIF, JPEG 2000, PSD),
/// procura o pacote XMP, que neles não é comprimido.
fn has_text(file: &[u8]) -> bool {
    const RDF: &[u8] = b"<rdf:RDF";
    let (iim, xmp) = file_iim_xmp(file);
    iim.is_some() || xmp.is_some() || file.windows(RDF.len()).any(|w| w == RDF)
}

fn jpeg_iim_xmp(file: &[u8]) -> (Option<Vec<u8>>, Option<String>) {
    use super::container::{XMP_EXT_NS, XMP_NS, jpeg_merge_xmp};
    let (mut iim, mut xmp, mut ext) = (None, None, Vec::new());
    for (marker, seg) in jpeg_segments(file) {
        if marker == 0xE1 {
            if let Some(x) = seg.strip_prefix(XMP_NS) {
                xmp = Some(String::from_utf8_lossy(x).into_owned());
            } else if seg.starts_with(XMP_EXT_NS) {
                ext.push(seg);
            }
        }
        if marker == 0xED
            && let Some(rest) = seg.strip_prefix(b"Photoshop 3.0\0")
        {
            iim = photoshop_resource(rest, 0x0404).map(<[u8]>::to_vec).or(iim);
        }
    }
    (iim, xmp.map(|x| jpeg_merge_xmp(x, &ext)))
}

/// Dados do recurso `id` numa sequência de recursos `8BIM`.
fn photoshop_resource(mut rest: &[u8], want: u16) -> Option<&[u8]> {
    // Recursos: "8BIM" id(2) nome-pascal(par) tamanho(4) dados(par).
    while let Some(r) = rest.strip_prefix(b"8BIM") {
        let id = u16::from_be_bytes([*r.first()?, *r.get(1)?]);
        let name_total = (1 + *r.get(2)? as usize).next_multiple_of(2);
        let size =
            u32::from_be_bytes(r.get(2 + name_total..6 + name_total)?.try_into().ok()?) as usize;
        let start = 6 + name_total;
        let data = r.get(start..start + size)?;
        if id == want {
            return Some(data);
        }
        rest = r.get(start + size.next_multiple_of(2)..).unwrap_or(&[]);
    }
    None
}

fn iptc_label(dataset: u8) -> Option<&'static str> {
    Some(match dataset {
        5 => "Title",
        10 => "Urgency",
        15 => "Category",
        40 => "Instructions",
        55 => "Date Created",
        80 => "Creator",
        85 => "Creator Title",
        90 => "City",
        92 => "Sublocation",
        95 => "State",
        101 => "Country",
        105 => "Headline",
        110 => "Credit",
        115 => "Source",
        116 => "Copyright",
        120 => "Caption",
        122 => "Caption Writer",
        _ => return None,
    })
}

fn parse_iim(mut d: &[u8], fields: &mut Vec<(String, String)>, keywords: &mut Vec<String>) {
    while d.len() >= 5 && d[0] == 0x1C {
        let (rec, num) = (d[1], d[2]);
        let len = u16::from_be_bytes([d[3], d[4]]) as usize;
        if len & 0x8000 != 0 {
            return; // tamanho estendido: não usado nos campos que lemos
        }
        let Some(v) = d.get(5..5 + len) else { return };
        d = &d[5 + len..];
        if rec != 2 {
            continue;
        }
        let text = metaedit::text_bytes(v).trim().to_string();
        if num == 25 {
            if !text.is_empty() && !keywords.contains(&text) {
                keywords.push(text);
            }
        } else if let Some(label) = iptc_label(num) {
            fields.push((label.to_string(), text));
        }
    }
}

/// Teto de palavras-chave lidas de um XMP (o `contains` de cada uma é linear).
const MAX_KEYWORDS: usize = 2000;

/// Itens de `<dc:subject>` de um pacote XMP.
fn xmp_keywords(xmp: &str) -> Vec<String> {
    let xmp = metaedit::cap_str(xmp, metaedit::MAX_XMP_KEYWORDS);
    let mut out = vec![];
    let Some(a) = xmp.find("<dc:subject>") else {
        return out;
    };
    let body = &xmp[a..];
    let body = &body[..body.find("</dc:subject>").unwrap_or(body.len())];
    for part in body.split("<rdf:li").skip(1).take(MAX_KEYWORDS) {
        let (Some(s), Some(e)) = (part.find('>'), part.find("</rdf:li>")) else {
            continue;
        };
        if s < e {
            let t = xml_unescape(part[s + 1..e].trim());
            if !t.is_empty() && !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

/// Nome do perfil ICC: tag `desc` (v2 `desc`, v4 `mluc`).
pub fn icc_description(icc: &[u8]) -> Option<String> {
    let be32 = |o: usize| -> Option<usize> {
        icc.get(o..o + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let count = be32(128)?.min(256);
    (0..count).find_map(|i| {
        let e = 132 + i * 12;
        if icc.get(e..e + 4)? != b"desc" {
            return None;
        }
        let (off, size) = (be32(e + 4)?, be32(e + 8)?);
        let tag = icc.get(off..off.checked_add(size)?)?;
        let text = match tag.get(..4)? {
            b"desc" => {
                let n = u32::from_be_bytes(tag.get(8..12)?.try_into().ok()?) as usize;
                let s = tag.get(12..12usize.checked_add(n)?)?;
                String::from_utf8_lossy(s).into_owned()
            }
            b"mluc" => {
                // Primeiro registro: tamanho(4) offset(4) a partir de 20.
                let len = u32::from_be_bytes(tag.get(20..24)?.try_into().ok()?) as usize;
                let o = u32::from_be_bytes(tag.get(24..28)?.try_into().ok()?) as usize;
                let s = tag.get(o..o.checked_add(len)?)?;
                let units: Vec<u16> = s.as_chunks::<2>().0.iter().map(|&c| u16::from_be_bytes(c)).collect();
                String::from_utf16_lossy(&units)
            }
            _ => return None,
        };
        let text = text.trim_end_matches('\0').trim().to_string();
        (!text.is_empty()).then_some(text)
    })
}

/// Modelo de cor, bits por canal e alfa. Lê o tipo de cor do arquivo; se o formato não
/// passa pelo crate `image` (SVG, HEIC, RAW...), assume 8 bits RGB e olha o alfa decodificado.
fn color_info(bytes: &[u8], decoded: &Decoded) -> (String, u8, bool) {
    let from_file = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_decoder().ok())
        .map(|d| d.color_type());
    match from_file {
        Some(ct) => {
            let model = if ct.has_color() { "RGB" } else { "Gray" };
            let depth = (ct.bits_per_pixel() / u16::from(ct.channel_count())) as u8;
            (model.to_string(), depth, ct.has_alpha())
        }
        None => {
            let alpha = decoded
                .frames
                .first()
                .is_some_and(|f| f.as_raw().par_chunks_exact(4).any(|p| p[3] < 255));
            ("RGB".to_string(), 8, alpha)
        }
    }
}

/// Instante em `YYYY-MM-DDTHH:MM:SSZ` (UTC), sem depender de crate de datas.
fn iso_utc(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Dias desde 1970-01-01 para data civil (algoritmo de Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn textos_com_acento_do_exif_e_do_iptc_saem_decodificados() {
        let asc = |b: &[u8]| (0x013Bu16, 2u16, b.len() as u32 + 1, [b, &[0]].concat());
        let autor = |b: &[u8]| {
            let tiff = crate::image::test_util::tiff_le(&[asc(b)]);
            known_texts(None, Some(&tiff))[2].clone()
        };
        assert_eq!(autor("José Simões".as_bytes()).as_deref(), Some("José Simões"));
        assert_eq!(autor(b"Jos\xe9 Sim\xf5es").as_deref(), Some("José Simões"), "Latin-1");
        assert_eq!(autor(b"Ana \"Nina\" \\ Cia").as_deref(), Some("Ana \"Nina\" \\ Cia"));
        assert_eq!(autor(b"Ana\0Bia").as_deref(), Some("Ana, Bia"));
        let mut iim = vec![0x1C, 2, 120, 0, 10];
        iim.extend_from_slice(b"Legenda \xe7\xe3");
        assert_eq!(known_texts(Some(&iim), None)[1].as_deref(), Some("Legenda çã"));
    }

    #[test]
    fn data_iso() {
        assert_eq!(iso_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        let t = UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        assert_eq!(iso_utc(t), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn icc_truncado_nao_panica() {
        assert_eq!(icc_description(&[0; 10]), None);
        assert_eq!(icc_description(&[0; 200]), None);
    }
}
