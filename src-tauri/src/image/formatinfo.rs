//! Abas por formato do Inspetor (Lote 9): JFIF, PNG, GIF, HEIF e TIFF, lidas direto dos bytes do
//! arquivo. O arquivo não é confiável: toda leitura usa `get` (nada de índice direto), os laços
//! têm teto de iterações e os textos saem sem controles e com tamanho limitado.
use super::makernote::{Entry, ifd_entries, tiff_header, u16_at};

pub type Rows = Vec<(String, String)>;

/// Uma aba de formato: `id` é `tiff`, `jfif`, `png`, `gif` ou `heif`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Section {
    pub id: &'static str,
    pub rows: Rows,
}

/// Teto de caracteres de um valor de texto exibido.
const MAX_TEXT: usize = 512;
/// Teto de linhas de texto livre (chunks `tEXt` do PNG, comentários do GIF).
const MAX_TEXT_ROWS: usize = 32;

/// Texto seguro para exibir: sem controles, com teto. Nunca é HTML (o front o mostra como texto).
pub fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_TEXT)
        .collect::<String>()
        .trim()
        .to_string()
}

fn be16(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(o..o.checked_add(2)?)?.try_into().ok()?))
}

fn be32(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(o..o.checked_add(4)?)?.try_into().ok()?))
}

fn le16(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o.checked_add(2)?)?.try_into().ok()?))
}

fn row(rows: &mut Rows, k: &str, v: impl Into<String>) {
    rows.push((k.to_string(), v.into()));
}

fn yes_no(b: bool) -> &'static str {
    if b { "Yes" } else { "No" }
}

/// Abas do arquivo `file`; `exif_tiff` é o bloco EXIF já extraído na abertura.
pub fn sections(file: &[u8], exif_tiff: Option<&[u8]>) -> Vec<Section> {
    let mut out = Vec::new();
    let mut add = |id, rows: Rows| {
        if !rows.is_empty() {
            out.push(Section { id, rows });
        }
    };
    if file.starts_with(&[0xFF, 0xD8]) {
        add("jfif", jfif(file));
    } else if file.starts_with(b"\x89PNG\r\n\x1a\n") {
        add("png", png(file));
    } else if file.starts_with(b"GIF8") {
        add("gif", gif(file));
    } else if file.get(4..8) == Some(b"ftyp") {
        add("heif", heif(file));
    }
    let tiff = tiff_rows(file, exif_tiff);
    add("tiff", tiff);
    out
}

// ---------- JFIF ----------

fn jfif(file: &[u8]) -> Rows {
    let mut rows = Rows::new();
    let mut sof = None;
    let mut found = false;
    for (marker, seg) in super::metadata::jpeg_segments(file).take(4096) {
        if marker == 0xE0 && seg.starts_with(b"JFIF\0") && !found {
            found = true;
            let (Some(&maj), Some(&min), Some(&unit)) = (seg.get(5), seg.get(6), seg.get(7)) else {
                continue;
            };
            row(&mut rows, "JFIF Version", format!("{maj}.{min:02}"));
            let unit_name = match unit {
                0 => "None (aspect ratio)",
                1 => "Dots per inch",
                2 => "Dots per centimeter",
                _ => "Unknown",
            };
            row(&mut rows, "Density Unit", unit_name);
            if let (Some(x), Some(y)) = (be16(seg, 8), be16(seg, 10)) {
                row(&mut rows, "X Density", x.to_string());
                row(&mut rows, "Y Density", y.to_string());
            }
            if let (Some(&w), Some(&h)) = (seg.get(12), seg.get(13))
                && (w, h) != (0, 0)
            {
                row(&mut rows, "Thumbnail", format!("{w} × {h}"));
            }
        }
        if sof.is_none() && matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            sof = Some((marker, seg));
        }
    }
    if !found {
        return Rows::new();
    }
    if let Some((marker, seg)) = sof {
        let progressive = matches!(marker, 0xC2 | 0xC6 | 0xCA | 0xCE);
        row(&mut rows, "Is Progressive", yes_no(progressive));
        if let Some(&bits) = seg.first() {
            row(&mut rows, "Bits per Component", bits.to_string());
        }
        if let Some(&n) = seg.get(5) {
            row(&mut rows, "Color Components", n.to_string());
        }
    }
    rows
}

// ---------- PNG ----------

fn png(file: &[u8]) -> Rows {
    let mut rows = Rows::new();
    let mut texts = 0usize;
    let mut pos = 8usize;
    for _ in 0..20_000 {
        let (Some(len), Some(ty)) = (be32(file, pos), file.get(pos + 4..pos + 8)) else {
            break;
        };
        let start = pos + 8;
        let Some(end) = start.checked_add(len as usize) else {
            break;
        };
        let Some(d) = file.get(start..end) else { break };
        match ty {
            b"IHDR" => {
                if let (Some(&depth), Some(&ct), Some(&il)) = (d.get(8), d.get(9), d.get(12)) {
                    row(&mut rows, "Bit Depth", depth.to_string());
                    let ct_name = match ct {
                        0 => "Grayscale",
                        2 => "RGB",
                        3 => "Indexed",
                        4 => "Grayscale + Alpha",
                        6 => "RGB + Alpha",
                        _ => "Unknown",
                    };
                    row(&mut rows, "Color Type", ct_name);
                    row(&mut rows, "Interlace", if il == 1 { "Adam7" } else { "None" });
                }
            }
            b"PLTE" => row(&mut rows, "Palette Entries", (d.len() / 3).to_string()),
            b"gAMA" => {
                if let Some(g) = be32(d, 0).filter(|&g| g > 0) {
                    row(&mut rows, "Gamma", format!("{:.4}", f64::from(g) / 100_000.0));
                }
            }
            b"sRGB" => {
                let name = match d.first() {
                    Some(0) => "Perceptual",
                    Some(1) => "Relative Colorimetric",
                    Some(2) => "Saturation",
                    Some(3) => "Absolute Colorimetric",
                    _ => "Unknown",
                };
                row(&mut rows, "sRGB Rendering Intent", name);
            }
            b"cHRM" => {
                let v: Vec<f64> = (0..8)
                    .filter_map(|i| be32(d, i * 4).map(|x| f64::from(x) / 100_000.0))
                    .collect();
                if v.len() == 8 {
                    row(&mut rows, "White Point", format!("{:.4}, {:.4}", v[0], v[1]));
                    row(
                        &mut rows,
                        "Primaries",
                        format!(
                            "R {:.4}, {:.4}  G {:.4}, {:.4}  B {:.4}, {:.4}",
                            v[2], v[3], v[4], v[5], v[6], v[7]
                        ),
                    );
                }
            }
            b"pHYs" => {
                if let (Some(x), Some(y), Some(&u)) = (be32(d, 0), be32(d, 4), d.get(8)) {
                    row(&mut rows, "Pixels per Unit X", x.to_string());
                    row(&mut rows, "Pixels per Unit Y", y.to_string());
                    row(&mut rows, "Unit", if u == 1 { "Meter" } else { "Unknown" });
                }
            }
            b"iCCP" => {
                let name = d.split(|&b| b == 0).next().unwrap_or(&[]);
                row(&mut rows, "ICC Profile", sanitize(&latin1(name)));
            }
            b"tIME" => {
                if let (Some(y), Some(c)) = (be16(d, 0), d.get(2..7)) {
                    row(
                        &mut rows,
                        "Last Modified",
                        format!("{y:04}-{:02}-{:02} {:02}:{:02}:{:02}", c[0], c[1], c[2], c[3], c[4]),
                    );
                }
            }
            b"acTL" => {
                if let (Some(n), Some(p)) = (be32(d, 0), be32(d, 4)) {
                    row(&mut rows, "Animation Frames", n.to_string());
                    row(&mut rows, "Animation Plays", if p == 0 { "Infinite".into() } else { p.to_string() });
                }
            }
            b"tEXt" | b"iTXt" if texts < MAX_TEXT_ROWS => {
                if let Some((k, v)) = png_text(ty == b"iTXt", d) {
                    texts += 1;
                    row(&mut rows, &sanitize(&k), sanitize(&v));
                }
            }
            b"IEND" => break,
            _ => {}
        }
        pos = end.saturating_add(4); // CRC
    }
    rows
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| char::from(c)).collect()
}

/// `(palavra-chave, texto)` de um `tEXt` (Latin-1) ou `iTXt` sem compressão (UTF-8).
fn png_text(international: bool, d: &[u8]) -> Option<(String, String)> {
    let nul = d.iter().position(|&b| b == 0)?;
    let key = latin1(d.get(..nul)?);
    let rest = d.get(nul + 1..)?;
    if !international {
        return Some((key, latin1(rest)));
    }
    // iTXt: compressão(1) método(1) idioma\0 palavra-chave traduzida\0 texto.
    if *rest.first()? != 0 {
        return None; // comprimido: não descomprimimos dados do arquivo
    }
    let body = rest.get(2..)?;
    let lang_end = body.iter().position(|&b| b == 0)?;
    let after = body.get(lang_end + 1..)?;
    let tr_end = after.iter().position(|&b| b == 0)?;
    let text = after.get(tr_end + 1..)?;
    Some((key, String::from_utf8_lossy(text).into_owned()))
}

// ---------- GIF ----------

fn gif(file: &[u8]) -> Rows {
    let mut rows = Rows::new();
    let Some(head) = file.get(..13) else {
        return rows;
    };
    row(&mut rows, "Version", sanitize(&latin1(&head[3..6])));
    let packed = head[10];
    if packed & 0x80 != 0 {
        row(&mut rows, "Global Palette", (2usize << (packed & 7)).to_string());
    }
    row(&mut rows, "Background Color Index", head[11].to_string());
    if head[12] != 0 {
        row(&mut rows, "Pixel Aspect Ratio", format!("{:.2}", (f64::from(head[12]) + 15.0) / 64.0));
    }
    let mut pos = 13usize;
    if packed & 0x80 != 0 {
        pos += 3 * (2usize << (packed & 7));
    }
    let (mut frames, mut delay_cs, mut loops, mut interlaced) = (0u32, 0u64, None, false);
    let mut comments = 0usize;
    let mut blocks = 0u32;
    while blocks < 200_000 {
        blocks += 1;
        let Some(&intro) = file.get(pos) else { break };
        pos += 1;
        match intro {
            0x21 => {
                let Some(&label) = file.get(pos) else { break };
                pos += 1;
                let start = pos;
                let Some(next) = skip_sub_blocks(file, pos) else {
                    break;
                };
                let first = file.get(start + 1..).unwrap_or(&[]);
                match label {
                    0xF9 => {
                        if let Some(d) = le16(file, start + 2) {
                            delay_cs += u64::from(d);
                        }
                    }
                    0xFF if first.starts_with(b"NETSCAPE2.0") || first.starts_with(b"ANIMEXTS1.0") => {
                        // Sub-bloco seguinte: 0x01 laços(2).
                        if let Some(n) = le16(file, start + 1 + 11 + 2) {
                            loops = Some(n);
                        }
                    }
                    0xFE if comments < MAX_TEXT_ROWS => {
                        let text = sub_block_bytes(file, start);
                        if !text.is_empty() {
                            comments += 1;
                            row(&mut rows, "Comment", sanitize(&latin1(&text)));
                        }
                    }
                    _ => {}
                }
                pos = next;
            }
            0x2C => {
                let Some(&p) = file.get(pos + 8) else { break };
                frames += 1;
                if frames == 1 {
                    interlaced = p & 0x40 != 0;
                }
                pos += 9;
                if p & 0x80 != 0 {
                    pos += 3 * (2usize << (p & 7));
                }
                pos += 1; // tamanho mínimo do código LZW
                let Some(next) = skip_sub_blocks(file, pos) else {
                    break;
                };
                pos = next;
            }
            _ => break, // 0x3B (fim) ou lixo
        }
    }
    row(&mut rows, "Frames", frames.to_string());
    if frames > 1 {
        row(&mut rows, "Duration", format!("{:.2} s", delay_cs as f64 / 100.0));
        let l = loops.map_or("Not specified".to_string(), |n| {
            if n == 0 { "Infinite".into() } else { n.to_string() }
        });
        row(&mut rows, "Loop Count", l);
    }
    row(&mut rows, "Interlaced", yes_no(interlaced));
    rows
}

/// Posição depois da sequência de sub-blocos que começa em `pos` (termina no bloco de tamanho 0).
fn skip_sub_blocks(file: &[u8], mut pos: usize) -> Option<usize> {
    for _ in 0..1_000_000 {
        let n = usize::from(*file.get(pos)?);
        pos = pos.checked_add(1 + n)?;
        if n == 0 {
            return (pos <= file.len()).then_some(pos);
        }
    }
    None
}

/// Conteúdo concatenado dos sub-blocos que começam em `pos` (para o texto de um comentário).
fn sub_block_bytes(file: &[u8], mut pos: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(&n) = file.get(pos) {
        if n == 0 || out.len() > MAX_TEXT {
            break;
        }
        match file.get(pos + 1..pos + 1 + usize::from(n)) {
            Some(s) => out.extend_from_slice(s),
            None => break,
        }
        pos += 1 + usize::from(n);
    }
    out
}

// ---------- HEIF / AVIF ----------

/// Teto de caixas visitadas e de profundidade (arquivo forjado com aninhamento absurdo).
const MAX_BOXES: usize = 4096;
const MAX_DEPTH: usize = 6;

/// Caixas ISO BMFF de `d`: `(tipo, conteúdo)`. Tamanho inválido encerra a lista.
fn boxes(d: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    let mut pos = 0usize;
    std::iter::from_fn(move || {
        let size = be32(d, pos)? as usize;
        let ty = d.get(pos + 4..pos + 8)?;
        let (head, total) = match size {
            0 => (8, d.len().checked_sub(pos)?),
            1 => (16, usize::try_from(u64::from_be_bytes(d.get(pos + 8..pos + 16)?.try_into().ok()?)).ok()?),
            n => (8, n),
        };
        if total < head {
            return None;
        }
        let end = pos.checked_add(total)?;
        let body = d.get(pos + head..end)?;
        pos = end;
        Some((ty, body))
    })
}

#[derive(Default)]
struct HeifInfo {
    dims: Option<(u32, u32)>,
    bits: Option<Vec<u8>>,
    colr: Option<String>,
    rotation: Option<u8>,
    mirror: Option<u8>,
    codec: Option<&'static str>,
    items: Option<u32>,
}

fn heif_walk(d: &[u8], depth: usize, left: &mut usize, info: &mut HeifInfo) {
    for (ty, body) in boxes(d) {
        if *left == 0 {
            return;
        }
        *left -= 1;
        match ty {
            b"meta" if depth < MAX_DEPTH => heif_walk(body.get(4..).unwrap_or(&[]), depth + 1, left, info),
            b"iprp" | b"ipco" if depth < MAX_DEPTH => heif_walk(body, depth + 1, left, info),
            b"iinf" => {
                let wide = body.first().is_some_and(|&v| v > 0);
                info.items = if wide { be32(body, 4) } else { be16(body, 4).map(u32::from) };
            }
            b"ispe" => {
                if let (Some(w), Some(h)) = (be32(body, 4), be32(body, 8)) {
                    // Vários `ispe` (miniaturas, grade): vale o maior.
                    let area = |d: (u32, u32)| u64::from(d.0) * u64::from(d.1);
                    if info.dims.is_none_or(|c| area((w, h)) > area(c)) {
                        info.dims = Some((w, h));
                    }
                }
            }
            b"pixi" if info.bits.is_none() => {
                if let Some(&n) = body.get(4) {
                    info.bits = body.get(5..5 + usize::from(n)).map(<[u8]>::to_vec);
                }
            }
            b"colr" if info.colr.is_none() => {
                info.colr = match body.get(..4) {
                    Some(b"nclx") => {
                        let (p, t, m) = (be16(body, 4), be16(body, 6), be16(body, 8));
                        let full = body.get(10).map(|f| f & 0x80 != 0);
                        match (p, t, m, full) {
                            (Some(p), Some(t), Some(m), Some(f)) => Some(format!(
                                "nclx primaries {p}, transfer {t}, matrix {m}, {}",
                                if f { "full range" } else { "limited range" }
                            )),
                            _ => None,
                        }
                    }
                    Some(b"rICC" | b"prof") => Some("ICC profile".to_string()),
                    _ => None,
                };
            }
            b"irot" => info.rotation = body.first().map(|a| a & 3),
            b"imir" => info.mirror = body.first().map(|a| a & 1),
            b"hvcC" => info.codec = Some("HEVC"),
            b"av1C" => info.codec = Some("AV1"),
            b"avcC" => info.codec = Some("AVC"),
            _ => {}
        }
    }
}

fn brand(b: &[u8]) -> String {
    sanitize(&latin1(b)).trim().to_string()
}

fn heif(file: &[u8]) -> Rows {
    let mut rows = Rows::new();
    let Some((_, ftyp)) = boxes(file).find(|(t, _)| *t == b"ftyp") else {
        return rows;
    };
    let Some(major) = ftyp.get(..4) else {
        return rows;
    };
    row(&mut rows, "Major Brand", brand(major));
    let compat: Vec<String> = ftyp
        .get(8..)
        .unwrap_or(&[])
        .as_chunks::<4>().0.iter()
        .take(16)
        .map(|c| brand(c))
        .collect();
    if !compat.is_empty() {
        row(&mut rows, "Compatible Brands", compat.join(", "));
    }
    let mut info = HeifInfo::default();
    let mut left = MAX_BOXES;
    heif_walk(file, 0, &mut left, &mut info);
    if let Some(c) = info.codec {
        row(&mut rows, "Codec", c);
    }
    if let Some((w, h)) = info.dims {
        row(&mut rows, "Image Size", format!("{w} × {h}"));
    }
    if let Some(bits) = info.bits.filter(|b| !b.is_empty()) {
        let list: Vec<String> = bits.iter().take(8).map(|b| b.to_string()).collect();
        row(&mut rows, "Bits per Channel", list.join(", "));
    }
    if let Some(c) = info.colr {
        row(&mut rows, "Color", c);
    }
    if let Some(r) = info.rotation.filter(|&r| r != 0) {
        row(&mut rows, "Rotation", format!("{}°", u32::from(r) * 90));
    }
    if let Some(m) = info.mirror {
        row(&mut rows, "Mirror", if m == 0 { "Vertical axis" } else { "Horizontal axis" });
    }
    if let Some(n) = info.items {
        row(&mut rows, "Items", n.to_string());
    }
    rows
}

// ---------- TIFF ----------

/// Tags do IFD0 que são ponteiros ou blobs enormes: não são "informação" para exibir.
const TIFF_SKIP: [u16; 15] = [
    273, 279, 288, 289, 324, 325, 513, 514, 700, 33723, 34377, 34675, 0x8769, 0x8825, 0xA005,
];
/// Máximo de elementos de um valor que viram texto na aba.
const MAX_SHOWN: usize = 16;

/// Valor de uma entrada, com no máximo `MAX_SHOWN` elementos (e `MAX_TEXT` bytes de texto).
fn tiff_value(e: &Entry) -> Option<exif::Value> {
    use exif::{Rational, SRational, Value};
    let (d, le) = (e.data, e.le);
    let n = e.count.min(MAX_SHOWN);
    let u32s = |i: usize| -> Option<u32> {
        let a: [u8; 4] = d.get(i * 4..i * 4 + 4)?.try_into().ok()?;
        Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    };
    let shorts = || (0..n).filter_map(|i| u16_at(d, i * 2, le));
    Some(match e.ty {
        1 => Value::Byte(d.iter().copied().take(n).collect()),
        2 => {
            let text = &d[..d.len().min(MAX_TEXT)];
            let end = text.iter().position(|&b| b == 0).unwrap_or(text.len());
            Value::Ascii(vec![text[..end].to_vec()])
        }
        3 => Value::Short(shorts().collect()),
        4 => Value::Long((0..n).filter_map(u32s).collect()),
        5 => Value::Rational(
            (0..n)
                .filter_map(|i| Some(Rational { num: u32s(i * 2)?, denom: u32s(i * 2 + 1)? }))
                .collect(),
        ),
        6 => Value::SByte(d.iter().take(n).map(|&b| b as i8).collect()),
        7 => Value::Undefined(d.iter().copied().take(MAX_SHOWN).collect(), 0),
        8 => Value::SShort(shorts().map(|v| v as i16).collect()),
        9 => Value::SLong((0..n).filter_map(u32s).map(|v| v as i32).collect()),
        10 => Value::SRational(
            (0..n)
                .filter_map(|i| {
                    Some(SRational { num: u32s(i * 2)? as i32, denom: u32s(i * 2 + 1)? as i32 })
                })
                .collect(),
        ),
        _ => return None,
    })
}

/// IFD0 do TIFF (o arquivo, se for TIFF, ou o bloco EXIF), lido com leitor limitado: sem montar o
/// arquivo inteiro na memória, sem ler valores grandes e sem formatar mais que `MAX_SHOWN` elementos.
fn tiff_rows(file: &[u8], exif_tiff: Option<&[u8]>) -> Rows {
    use exif::{Context, Field, In, Tag};
    let buf = if file.starts_with(b"II*\0") || file.starts_with(b"MM\0*") {
        file
    } else {
        exif_tiff.unwrap_or(&[])
    };
    let Some((ifd, le)) = tiff_header(buf) else {
        return Rows::new();
    };
    ifd_entries(buf, ifd, le)
        .iter()
        .filter(|e| !TIFF_SKIP.contains(&e.tag))
        .take(128)
        .filter_map(|e| {
            let f = Field { tag: Tag(Context::Tiff, e.tag), ifd_num: In::PRIMARY, value: tiff_value(e)? };
            Some((f.tag.to_string(), sanitize(f.display_value().to_string().trim_matches('"'))))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(rows: &'a Rows, k: &str) -> Option<&'a str> {
        rows.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }

    fn chunk(ty: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut o = (data.len() as u32).to_be_bytes().to_vec();
        o.extend_from_slice(ty);
        o.extend_from_slice(data);
        o.extend_from_slice(&[0; 4]);
        o
    }

    fn png_file(extra: &[Vec<u8>]) -> Vec<u8> {
        let mut f = b"\x89PNG\r\n\x1a\n".to_vec();
        let ihdr = vec![0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 1];
        f.extend(chunk(b"IHDR", &ihdr));
        for c in extra {
            f.extend_from_slice(c);
        }
        f.extend(chunk(b"IEND", &[]));
        f
    }

    #[test]
    fn png_le_ihdr_gama_fisico_e_texto() {
        let f = png_file(&[
            chunk(b"gAMA", &50000u32.to_be_bytes()),
            chunk(b"pHYs", &[0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1]),
            chunk(b"sRGB", &[0]),
            chunk(b"tEXt", b"Author\0Ana <b>"),
            chunk(b"zTXt", b"Comment\0\0xx"),
        ]);
        let r = png(&f);
        assert_eq!(get(&r, "Bit Depth"), Some("8"));
        assert_eq!(get(&r, "Color Type"), Some("RGB + Alpha"));
        assert_eq!(get(&r, "Interlace"), Some("Adam7"));
        assert_eq!(get(&r, "Gamma"), Some("0.5000"));
        assert_eq!(get(&r, "Pixels per Unit X"), Some("5669"));
        assert_eq!(get(&r, "sRGB Rendering Intent"), Some("Perceptual"));
        assert_eq!(get(&r, "Author"), Some("Ana <b>")); // texto puro, quem exibe não interpreta HTML
        assert_eq!(get(&r, "Comment"), None); // comprimido: ignorado
    }

    #[test]
    fn png_truncado_e_forjado_nao_panica() {
        let f = png_file(&[chunk(b"tEXt", b"K\0v")]);
        for n in 0..f.len() {
            let _ = png(&f[..n]);
            let _ = sections(&f[..n], None);
        }
        let mut forjado = b"\x89PNG\r\n\x1a\n".to_vec();
        forjado.extend_from_slice(&u32::MAX.to_be_bytes());
        forjado.extend_from_slice(b"tEXt");
        assert!(png(&forjado).is_empty());
        // Muitos chunks pequenos: termina e respeita o teto de linhas de texto.
        let mut muitos = png_file(&[]);
        muitos.truncate(muitos.len() - 12);
        for _ in 0..50_000 {
            muitos.extend(chunk(b"tEXt", b"a\0b"));
        }
        assert!(png(&muitos).len() <= MAX_TEXT_ROWS + 8);
    }

    #[test]
    fn texto_com_controles_vira_texto_limpo() {
        assert_eq!(sanitize("a\u{0}b\n<script>"), "a b <script>");
        assert_eq!(sanitize(&"x".repeat(5000)).len(), MAX_TEXT);
    }

    fn gif_file(frames: u32, with_loop: bool) -> Vec<u8> {
        let mut f = b"GIF89a".to_vec();
        f.extend_from_slice(&[4, 0, 4, 0, 0x81, 0, 0]); // 4x4, tabela global de 4 cores
        f.extend_from_slice(&[0; 12]);
        if with_loop {
            f.extend_from_slice(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x03\x00\x00");
        }
        f.extend_from_slice(b"\x21\xFE\x05hello\x00");
        for _ in 0..frames {
            f.extend_from_slice(&[0x21, 0xF9, 4, 0, 10, 0, 0, 0]); // atraso 10 cs
            f.extend_from_slice(&[0x2C, 0, 0, 0, 0, 4, 0, 4, 0, 0x40, 2, 1, 0x44, 0]);
        }
        f.push(0x3B);
        f
    }

    #[test]
    fn gif_conta_quadros_lacos_duracao_e_comentario() {
        let r = gif(&gif_file(3, true));
        assert_eq!(get(&r, "Version"), Some("89a"));
        assert_eq!(get(&r, "Global Palette"), Some("4"));
        assert_eq!(get(&r, "Frames"), Some("3"));
        assert_eq!(get(&r, "Loop Count"), Some("3"));
        assert_eq!(get(&r, "Duration"), Some("0.30 s"));
        assert_eq!(get(&r, "Comment"), Some("hello"));
        assert_eq!(get(&r, "Interlaced"), Some("Yes"));
        let r1 = gif(&gif_file(1, false));
        assert_eq!(get(&r1, "Loop Count"), None);
    }

    #[test]
    fn gif_truncado_nao_panica() {
        let f = gif_file(2, true);
        for n in 0..f.len() {
            let _ = gif(&f[..n]);
        }
        let mut ciclo = b"GIF89a\x01\0\x01\0\0\0\0".to_vec();
        ciclo.extend(std::iter::repeat_n(0x21u8, 100)); // extensões sem fim
        let _ = gif(&ciclo);
    }

    fn bx(ty: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut o = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        o.extend_from_slice(ty);
        o.extend_from_slice(body);
        o
    }

    fn heif_file() -> Vec<u8> {
        let mut ispe = vec![0; 4];
        ispe.extend_from_slice(&[0, 0, 0x0F, 0xA0, 0, 0, 0x0B, 0xB8]); // 4000x3000
        let mut pixi = vec![0; 4];
        pixi.extend_from_slice(&[3, 10, 10, 10]);
        let mut colr = b"nclx".to_vec();
        colr.extend_from_slice(&[0, 1, 0, 13, 0, 6, 0x80]);
        let ipco = [
            bx(b"ispe", &ispe),
            bx(b"pixi", &pixi),
            bx(b"colr", &colr),
            bx(b"irot", &[1]),
            bx(b"hvcC", &[1, 2, 3]),
        ]
        .concat();
        let iprp = bx(b"iprp", &bx(b"ipco", &ipco));
        let mut meta = vec![0; 4];
        meta.extend(iprp);
        let mut ftyp = b"heic".to_vec();
        ftyp.extend_from_slice(&[0, 0, 0, 0]);
        ftyp.extend_from_slice(b"mif1heic");
        [bx(b"ftyp", &ftyp), bx(b"meta", &meta)].concat()
    }

    #[test]
    fn heif_le_marca_dimensoes_bits_cor_e_giro() {
        let r = heif(&heif_file());
        assert_eq!(get(&r, "Major Brand"), Some("heic"));
        assert_eq!(get(&r, "Compatible Brands"), Some("mif1, heic"));
        assert_eq!(get(&r, "Codec"), Some("HEVC"));
        assert_eq!(get(&r, "Image Size"), Some("4000 × 3000"));
        assert_eq!(get(&r, "Bits per Channel"), Some("10, 10, 10"));
        assert_eq!(get(&r, "Rotation"), Some("90°"));
        assert!(get(&r, "Color").unwrap().contains("full range"));
    }

    #[test]
    fn heif_truncado_e_aninhamento_absurdo_nao_panicam() {
        let f = heif_file();
        for n in 0..f.len() {
            let _ = heif(&f[..n]);
        }
        // `meta` dentro de `meta` dentro de... (profundidade além do teto)
        let mut b = bx(b"free", &[]);
        for _ in 0..200 {
            let mut m = vec![0; 4];
            m.extend(b);
            b = bx(b"meta", &m);
        }
        let _ = heif(&[bx(b"ftyp", b"heic\0\0\0\0"), b].concat());
        // tamanho 64 bits absurdo e tamanho menor que o cabeçalho
        let mut c = vec![0, 0, 0, 1];
        c.extend_from_slice(b"ftyp");
        c.extend_from_slice(&u64::MAX.to_be_bytes());
        assert!(heif(&c).is_empty());
        assert!(heif(&[0, 0, 0, 4, b'f', b't', b'y', b'p']).is_empty());
    }

    fn jpeg_com_jfif(progressive: bool) -> Vec<u8> {
        let mut f = vec![0xFF, 0xD8];
        f.extend_from_slice(&[0xFF, 0xE0, 0, 16]);
        f.extend_from_slice(b"JFIF\0");
        f.extend_from_slice(&[1, 2, 1, 0, 72, 0, 72, 0, 0]);
        f.extend_from_slice(&[0xFF, if progressive { 0xC2 } else { 0xC0 }, 0, 11, 8, 0, 4, 0, 4, 3]);
        f.extend_from_slice(&[0, 0, 0]);
        f.extend_from_slice(&[0xFF, 0xDA, 0, 2]);
        f
    }

    #[test]
    fn jfif_le_versao_densidade_e_progressivo() {
        let r = jfif(&jpeg_com_jfif(true));
        assert_eq!(get(&r, "JFIF Version"), Some("1.02"));
        assert_eq!(get(&r, "Density Unit"), Some("Dots per inch"));
        assert_eq!(get(&r, "X Density"), Some("72"));
        assert_eq!(get(&r, "Is Progressive"), Some("Yes"));
        assert_eq!(get(&r, "Color Components"), Some("3"));
        assert_eq!(get(&jfif(&jpeg_com_jfif(false)), "Is Progressive"), Some("No"));
        assert!(jfif(&[0xFF, 0xD8, 0xFF, 0xD9]).is_empty());
    }

    #[test]
    fn jfif_truncado_nao_panica() {
        let f = jpeg_com_jfif(false);
        for n in 0..f.len() {
            let _ = jfif(&f[..n]);
            let _ = sections(&f[..n], None);
        }
    }

    fn tiff_forjado_com_entradas_grandes() -> Vec<u8> {
        let make = (5u32, b"Gera\0".to_vec());
        let grande_ascii = (200_000u32, vec![b'A'; 200_000]);
        let curtos = (30_000u32, vec![1u8; 60_000]); // SHORT: cabe no teto, mas só alguns são mostrados
        crate::image::test_util::tiff_le(&[
            (0x010F, 2, make.0, make.1),
            (0x010E, 2, grande_ascii.0, grande_ascii.1),
            (0x0102, 3, curtos.0, curtos.1),
        ])
    }

    #[test]
    fn tiff_ignora_entrada_grande_so_pelo_cabecalho_e_limita_os_elementos() {
        let f = tiff_forjado_com_entradas_grandes();
        let r = tiff_rows(&f, None);
        assert_eq!(get(&r, "Make"), Some("Gera"));
        assert_eq!(get(&r, "ImageDescription"), None, "valor de 200 KB não deve ser lido");
        let bits = get(&r, "BitsPerSample").expect("SHORT de 60 KB entra, truncado");
        assert!(bits.split_whitespace().count() <= 17, "{bits}");
        // o mesmo bloco, como EXIF de um JPEG
        let r2 = tiff_rows(b"\xFF\xD8", Some(&f));
        assert_eq!(r2, r);
    }

    #[test]
    fn tiff_com_ifd_forjado_nao_panica_nem_passa_do_teto() {
        let mut f = crate::image::test_util::tiff_le(&[(0x010F, 2, 5, b"Gera\0".to_vec())]);
        f[8..10].copy_from_slice(&u16::MAX.to_le_bytes()); // 65535 entradas num arquivo curto
        assert!(tiff_rows(&f, None).len() <= 128);
        f[4..8].copy_from_slice(&u32::MAX.to_le_bytes()); // IFD0 fora do arquivo
        assert!(tiff_rows(&f, None).is_empty());
        for n in 0..f.len() {
            let _ = tiff_rows(&f[..n], None);
        }
    }
}
