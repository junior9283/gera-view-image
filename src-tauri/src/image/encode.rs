//! Codificação para Salvar/Exportar: formatos, metadados levados junto e escrita atômica.
//!
//! Formatos sem codificador no binário: HEIC (o x265 é proibido no NEEDED) e JPEG 2000
//! (a única crate madura liga a libopenjp2). Ficam ocultos no diálogo e registrados no CHANGELOG.
use super::ops;
use crate::{
    doc::model::{ResizeFilter, SourceFormat},
    error::{AppError, AppResult},
};
use ::image::{
    DynamicImage, ImageEncoder, RgbImage, RgbaImage,
    codecs::{
        avif::AvifEncoder,
        bmp::BmpEncoder,
        jpeg::{JpegEncoder, PixelDensity},
        openexr::OpenExrEncoder,
        png::{CompressionType, FilterType, PngEncoder},
        tiff::TiffEncoder,
        webp::WebPEncoder,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    fs,
    io::{Cursor, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::atomic::{AtomicU32, Ordering},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Jpeg,
    Png,
    Tiff,
    Heic,
    Webp,
    Avif,
    Jp2,
    Exr,
    Bmp,
}

impl ExportFormat {
    /// Há codificador no binário.
    pub fn supported(self) -> bool {
        !matches!(self, ExportFormat::Heic | ExportFormat::Jp2)
    }

    fn keeps_alpha(self) -> bool {
        use ExportFormat::*;
        matches!(self, Png | Tiff | Webp | Avif | Exr)
    }

    /// Formato em que Salvar grava o arquivo de origem (`None` = só Exportar).
    pub fn for_save(src: SourceFormat) -> Option<Self> {
        Some(match src {
            SourceFormat::Jpeg => ExportFormat::Jpeg,
            SourceFormat::Png => ExportFormat::Png,
            SourceFormat::Tiff => ExportFormat::Tiff,
            SourceFormat::Webp => ExportFormat::Webp,
            SourceFormat::Avif => ExportFormat::Avif,
            SourceFormat::Bmp => ExportFormat::Bmp,
            _ => return None,
        })
    }

    /// Formato de origem equivalente (documento sem caminho que passa a ser este arquivo).
    pub fn source_format(self) -> SourceFormat {
        match self {
            ExportFormat::Jpeg => SourceFormat::Jpeg,
            ExportFormat::Png => SourceFormat::Png,
            ExportFormat::Tiff => SourceFormat::Tiff,
            ExportFormat::Heic => SourceFormat::Heic,
            ExportFormat::Webp => SourceFormat::Webp,
            ExportFormat::Avif => SourceFormat::Avif,
            ExportFormat::Bmp => SourceFormat::Bmp,
            // Sem leitura própria: o documento fica sem Salvar (vai para Exportar).
            ExportFormat::Jp2 | ExportFormat::Exr => SourceFormat::Raw,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: ExportFormat,
    /// 1..=100. `None`: JPEG 90, WebP sem perdas, AVIF 80.
    pub quality: Option<u8>,
    #[serde(default = "yes")]
    pub alpha: bool,
    /// PNG/TIFF em 16 bits por canal (o pipeline é de 8 bits: os valores são expandidos).
    #[serde(default)]
    pub depth16: bool,
    #[serde(default)]
    pub strip_metadata: bool,
    #[serde(default)]
    pub resize: Option<(u32, u32)>,
}

fn yes() -> bool {
    true
}

/// Metadados levados do original para o arquivo gravado (ignorados com `strip_metadata`,
/// exceto `dpi`, que é resolução de impressão e não dado pessoal).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetaCarry {
    /// Bloco TIFF do EXIF (a orientação é reescrita para 1 em `encode`).
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
    /// Registros IPTC-IIM crus do original (JPEG).
    pub iptc: Option<Vec<u8>>,
    /// Pacote XMP do original (JPEG).
    pub xmp: Option<String>,
    /// Palavras-chave editadas: substituem IPTC 2:25 e XMP `dc:subject`.
    pub iptc_keywords: Option<Vec<String>>,
    pub dpi: Option<(f32, f32)>,
}

const DEFAULT_JPEG_QUALITY: u8 = 90;
const DEFAULT_AVIF_QUALITY: u8 = 80;
/// rav1e sem assembly: 8 mantém a exportação em segundos sem perder muito em tamanho.
const AVIF_SPEED: u8 = 8;

fn enc_err(e: impl std::fmt::Display) -> AppError {
    AppError::Io(format!("falha ao codificar: {e}"))
}

/// Codifica `img` (RGBA8 já com todas as operações) conforme `opts`.
pub fn encode(img: &RgbaImage, opts: &ExportOptions, meta: &MetaCarry) -> AppResult<Vec<u8>> {
    let fmt = opts.format;
    if !fmt.supported() {
        return Err(AppError::Unsupported(format!(
            "sem codificador para {fmt:?} neste binário"
        )));
    }
    let img: Cow<RgbaImage> = match opts.resize {
        Some((w, h)) if w == 0 || h == 0 => {
            return Err(AppError::Unsupported("tamanho zero".into()));
        }
        Some((w, h)) if (w, h) != img.dimensions() => {
            Cow::Owned(ops::resize(img, w, h, ResizeFilter::Lanczos3))
        }
        _ => Cow::Borrowed(img),
    };
    let meta = if opts.strip_metadata {
        MetaCarry {
            dpi: meta.dpi,
            ..MetaCarry::default()
        }
    } else {
        MetaCarry {
            exif: meta.exif.as_deref().map(exif_reset_orientation),
            ..meta.clone()
        }
    };
    let with_alpha = opts.alpha && fmt.keeps_alpha() && img.pixels().any(|p| p[3] != 255);
    let pixels = if with_alpha {
        DynamicImage::ImageRgba8(img.into_owned())
    } else {
        DynamicImage::ImageRgb8(rgb_on_white(&img))
    };
    // Só PNG/TIFF gravam 16 bits por canal.
    let pixels = if opts.depth16 && matches!(fmt, ExportFormat::Png | ExportFormat::Tiff) {
        widen16(pixels)
    } else {
        pixels
    };
    let xmp = match &meta.iptc_keywords {
        Some(k) => Some(xmp_with_keywords(meta.xmp.as_deref(), k)),
        None => meta.xmp.clone(),
    };

    let mut out = Vec::new();
    match fmt {
        ExportFormat::Jpeg => {
            let mut e = JpegEncoder::new_with_quality(
                &mut out,
                opts.quality.unwrap_or(DEFAULT_JPEG_QUALITY).clamp(1, 100),
            );
            if let Some((x, _)) = meta.dpi {
                e.set_pixel_density(PixelDensity::dpi(x.round().clamp(1.0, 65535.0) as u16));
            }
            set_meta(&mut e, &meta);
            pixels.write_with_encoder(e).map_err(enc_err)?;
            let iptc = match &meta.iptc_keywords {
                Some(k) => Some(iim_with_keywords(meta.iptc.as_deref(), k)),
                None => meta.iptc.clone(),
            };
            out = jpeg_insert_segments(&out, iptc.as_deref(), xmp.as_deref());
        }
        ExportFormat::Png => {
            let mut e = PngEncoder::new_with_quality(
                &mut out,
                CompressionType::Default,
                FilterType::Adaptive,
            );
            set_meta(&mut e, &meta);
            pixels.write_with_encoder(e).map_err(enc_err)?;
            out = png_insert_chunks(&out, meta.dpi, xmp.as_deref());
        }
        ExportFormat::Tiff => {
            let mut c = Cursor::new(Vec::new());
            let mut e = TiffEncoder::new(&mut c);
            if let Some(icc) = &meta.icc {
                let _ = e.set_icc_profile(icc.clone());
            }
            pixels.write_with_encoder(e).map_err(enc_err)?;
            out = c.into_inner();
        }
        ExportFormat::Webp => {
            let (w, h) = (pixels.width(), pixels.height());
            let riff = match opts.quality {
                None => {
                    pixels
                        .write_with_encoder(WebPEncoder::new_lossless(&mut out))
                        .map_err(enc_err)?;
                    std::mem::take(&mut out)
                }
                Some(q) => {
                    let e = match &pixels {
                        DynamicImage::ImageRgba8(i) => webp::Encoder::from_rgba(i.as_raw(), w, h),
                        DynamicImage::ImageRgb8(i) => webp::Encoder::from_rgb(i.as_raw(), w, h),
                        _ => unreachable!("convertido para RGB8/RGBA8 acima"),
                    };
                    e.encode_simple(false, q.clamp(1, 100) as f32)
                        .map_err(|e| enc_err(format!("{e:?}")))?
                        .to_vec()
                }
            };
            out = webp_with_meta(&riff, (w, h), with_alpha, &meta, xmp.as_deref())?;
        }
        ExportFormat::Avif => {
            let mut e = AvifEncoder::new_with_speed_quality(
                &mut out,
                AVIF_SPEED,
                opts.quality.unwrap_or(DEFAULT_AVIF_QUALITY).clamp(1, 100),
            );
            if let Some(exif) = &meta.exif {
                let _ = e.set_exif_metadata(exif.clone());
            }
            pixels.write_with_encoder(e).map_err(enc_err)?;
        }
        ExportFormat::Bmp => {
            pixels
                .write_with_encoder(BmpEncoder::new(&mut out))
                .map_err(enc_err)?;
        }
        ExportFormat::Exr => {
            let mut c = Cursor::new(Vec::new());
            linear_f32(&pixels)
                .write_with_encoder(OpenExrEncoder::new(&mut c))
                .map_err(enc_err)?;
            out = c.into_inner();
        }
        ExportFormat::Heic | ExportFormat::Jp2 => unreachable!("recusados acima"),
    }
    Ok(out)
}

fn set_meta(e: &mut impl ImageEncoder, meta: &MetaCarry) {
    // Recusa de um encoder específico não impede a gravação da imagem.
    if let Some(icc) = &meta.icc {
        let _ = e.set_icc_profile(icc.clone());
    }
    if let Some(exif) = &meta.exif {
        let _ = e.set_exif_metadata(exif.clone());
    }
}

/// RGB8 com a transparência composta sobre branco (formatos sem alfa), numa passada só.
fn rgb_on_white(img: &RgbaImage) -> RgbImage {
    RgbImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        let a = p[3] as u32;
        let c = |v: u8| ((v as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
        ::image::Rgb([c(p[0]), c(p[1]), c(p[2])])
    })
}

fn widen16(img: DynamicImage) -> DynamicImage {
    match img {
        DynamicImage::ImageRgb8(_) => DynamicImage::ImageRgb16(img.into_rgb16()),
        other => DynamicImage::ImageRgba16(other.into_rgba16()),
    }
}

/// EXR guarda luz linear: desfaz a curva sRGB.
fn linear_f32(img: &DynamicImage) -> DynamicImage {
    let lut: Vec<f32> = (0..256)
        .map(|v| {
            let c = v as f32 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect();
    match img {
        DynamicImage::ImageRgba8(i) => DynamicImage::ImageRgba32F(::image::Rgba32FImage::from_fn(
            i.width(),
            i.height(),
            |x, y| {
                let p = i.get_pixel(x, y);
                ::image::Rgba([
                    lut[p[0] as usize],
                    lut[p[1] as usize],
                    lut[p[2] as usize],
                    p[3] as f32 / 255.0,
                ])
            },
        )),
        other => {
            let i = other.to_rgb8();
            DynamicImage::ImageRgb32F(::image::Rgb32FImage::from_fn(
                i.width(),
                i.height(),
                |x, y| {
                    let p = i.get_pixel(x, y);
                    ::image::Rgb([lut[p[0] as usize], lut[p[1] as usize], lut[p[2] as usize]])
                },
            ))
        }
    }
}

// ---------- EXIF ----------

/// Cópia do bloco TIFF do EXIF com `Orientation` (IFD0) = 1: os pixels gravados já estão
/// na orientação final. Bloco ilegível volta como veio.
pub fn exif_reset_orientation(tiff: &[u8]) -> Vec<u8> {
    let mut t = tiff.to_vec();
    let le = match t.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return t,
    };
    let u16_at = |b: &[u8], i: usize| {
        b.get(i..i + 2).map(|x| {
            let a = [x[0], x[1]];
            if le {
                u16::from_le_bytes(a)
            } else {
                u16::from_be_bytes(a)
            }
        })
    };
    let Some(ifd) = t.get(4..8).map(|x| {
        let a = [x[0], x[1], x[2], x[3]];
        (if le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        }) as usize
    }) else {
        return t;
    };
    let Some(n) = u16_at(&t, ifd) else { return t };
    for k in 0..n as usize {
        let e = ifd + 2 + k * 12;
        if u16_at(&t, e) == Some(0x0112) && u16_at(&t, e + 2) == Some(3) && e + 10 <= t.len() {
            let one = if le {
                1u16.to_le_bytes()
            } else {
                1u16.to_be_bytes()
            };
            t[e + 8..e + 10].copy_from_slice(&one);
        }
    }
    t
}

// ---------- IPTC / XMP ----------

/// IIM com os registros 2:25 trocados por `keywords` (e 1:90 = UTF-8).
pub fn iim_with_keywords(orig: Option<&[u8]>, keywords: &[String]) -> Vec<u8> {
    let rec = |r: u8, n: u8, v: &[u8]| {
        let len = v.len().min(0x7FFF) as u16;
        let mut o = vec![0x1C, r, n];
        o.extend_from_slice(&len.to_be_bytes());
        o.extend_from_slice(&v[..len as usize]);
        o
    };
    let mut out = rec(1, 90, b"\x1B%G");
    let mut d = orig.unwrap_or(&[]);
    while d.len() >= 5 && d[0] == 0x1C {
        let len = u16::from_be_bytes([d[3], d[4]]) as usize;
        if len & 0x8000 != 0 || d.len() < 5 + len {
            break;
        }
        let (r, n) = (d[1], d[2]);
        if !(r == 2 && n == 25) && !(r == 1 && n == 90) {
            out.extend_from_slice(&d[..5 + len]);
        }
        d = &d[5 + len..];
    }
    for k in keywords {
        out.extend(rec(2, 25, k.as_bytes()));
    }
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Pacote XMP com `dc:subject` = `keywords` (mantém o resto do pacote original).
pub fn xmp_with_keywords(orig: Option<&str>, keywords: &[String]) -> String {
    let items: String = keywords
        .iter()
        .map(|k| format!("<rdf:li>{}</rdf:li>", xml_escape(k)))
        .collect();
    let subject = format!("<dc:subject><rdf:Bag>{items}</rdf:Bag></dc:subject>");
    if let Some(x) = orig {
        if let (Some(a), Some(b)) = (x.find("<dc:subject>"), x.find("</dc:subject>"))
            && a < b
        {
            return format!("{}{subject}{}", &x[..a], &x[b + "</dc:subject>".len()..]);
        }
        if let Some(end) = x.find("</rdf:RDF>") {
            return format!(
                "{}<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{subject}</rdf:Description>{}",
                &x[..end],
                &x[end..]
            );
        }
    }
    format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{subject}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
}

const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn jpeg_segment(marker: u8, payload: &[u8]) -> Option<Vec<u8>> {
    let len = u16::try_from(payload.len() + 2).ok()?;
    let mut s = vec![0xFF, marker];
    s.extend_from_slice(&len.to_be_bytes());
    s.extend_from_slice(payload);
    Some(s)
}

/// Insere APP13 (IPTC) e APP1 (XMP) depois dos APPn que o codificador escreveu.
fn jpeg_insert_segments(jpg: &[u8], iim: Option<&[u8]>, xmp: Option<&str>) -> Vec<u8> {
    let mut extra = Vec::new();
    if let Some(iim) = iim {
        let mut p = b"Photoshop 3.0\08BIM\x04\x04\0\0".to_vec();
        p.extend_from_slice(&(iim.len() as u32).to_be_bytes());
        p.extend_from_slice(iim);
        if iim.len() % 2 == 1 {
            p.push(0);
        }
        extra.extend(jpeg_segment(0xED, &p).unwrap_or_default());
    }
    if let Some(x) = xmp {
        extra.extend(jpeg_segment(0xE1, &[XMP_NS, x.as_bytes()].concat()).unwrap_or_default());
    }
    if extra.is_empty() {
        return jpg.to_vec();
    }
    // Pula SOI e os segmentos APPn (JFIF, EXIF, ICC) do início.
    let mut pos = 2;
    while pos + 4 <= jpg.len() && jpg[pos] == 0xFF && (0xE0..=0xEF).contains(&jpg[pos + 1]) {
        pos += 2 + u16::from_be_bytes([jpg[pos + 2], jpg[pos + 3]]) as usize;
    }
    let pos = pos.min(jpg.len());
    [&jpg[..pos], &extra, &jpg[pos..]].concat()
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut c = (data.len() as u32).to_be_bytes().to_vec();
    c.extend_from_slice(kind);
    c.extend_from_slice(data);
    let mut h = crc32fast::Hasher::new();
    h.update(kind);
    h.update(data);
    c.extend_from_slice(&h.finalize().to_be_bytes());
    c
}

/// Insere `pHYs` (DPI) e `iTXt` XMP antes do primeiro IDAT.
fn png_insert_chunks(png: &[u8], dpi: Option<(f32, f32)>, xmp: Option<&str>) -> Vec<u8> {
    let mut extra = Vec::new();
    if let Some((x, y)) = dpi {
        let ppm = |d: f32| ((d / 0.0254).round() as u32).to_be_bytes();
        extra.extend(png_chunk(b"pHYs", &[&ppm(x)[..], &ppm(y), &[1]].concat()));
    }
    if let Some(x) = xmp {
        let data = [b"XML:com.adobe.xmp\0\0\0\0\0".as_slice(), x.as_bytes()].concat();
        extra.extend(png_chunk(b"iTXt", &data));
    }
    let mut pos = 8;
    while pos + 8 <= png.len() {
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().expect("4 bytes")) as usize;
        if &png[pos + 4..pos + 8] == b"IDAT" {
            return [&png[..pos], &extra, &png[pos..]].concat();
        }
        pos += 12 + len;
    }
    png.to_vec()
}

/// Recompõe o RIFF do WebP com VP8X + ICCP/EXIF/XMP (o libwebp simples não grava metadados).
fn webp_with_meta(
    riff: &[u8],
    (w, h): (u32, u32),
    alpha: bool,
    meta: &MetaCarry,
    xmp: Option<&str>,
) -> AppResult<Vec<u8>> {
    if meta.icc.is_none() && meta.exif.is_none() && xmp.is_none() {
        return Ok(riff.to_vec());
    }
    if riff.len() < 12 || &riff[..4] != b"RIFF" || &riff[8..12] != b"WEBP" {
        return Err(enc_err("WebP inválido"));
    }
    let chunk = |kind: &[u8], data: &[u8]| {
        let mut c = kind.to_vec();
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(data);
        if data.len() % 2 == 1 {
            c.push(0);
        }
        c
    };
    // Imagem: ALPH/VP8/VP8L do arquivo original (sem o VP8X dele).
    let mut image = Vec::new();
    let mut pos = 12;
    while pos + 8 <= riff.len() {
        let len = u32::from_le_bytes(riff[pos + 4..pos + 8].try_into().expect("4 bytes")) as usize;
        let end = (pos + 8 + len + len % 2).min(riff.len());
        if &riff[pos..pos + 4] != b"VP8X" {
            image.extend_from_slice(&riff[pos..end]);
        }
        pos = end;
    }
    let mut flags = 0u8;
    if meta.icc.is_some() {
        flags |= 0x20;
    }
    if alpha {
        flags |= 0x10;
    }
    if meta.exif.is_some() {
        flags |= 0x08;
    }
    if xmp.is_some() {
        flags |= 0x04;
    }
    let mut vp8x = vec![flags, 0, 0, 0];
    vp8x.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
    let mut body = b"WEBP".to_vec();
    body.extend(chunk(b"VP8X", &vp8x));
    if let Some(icc) = &meta.icc {
        body.extend(chunk(b"ICCP", icc));
    }
    body.extend(image);
    if let Some(exif) = &meta.exif {
        body.extend(chunk(b"EXIF", exif));
    }
    if let Some(x) = xmp {
        body.extend(chunk(b"XMP ", x.as_bytes()));
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend(body);
    Ok(out)
}

// ---------- JPEG: qualidade do original ----------

/// Tabela de luminância do anexo K da norma JPEG (a soma não depende da ordem zigue-zague).
const STD_LUMA_SUM: u32 = {
    const T: [u8; 64] = [
        16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69,
        56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81,
        104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
    ];
    let mut s = 0;
    let mut i = 0;
    while i < 64 {
        s += T[i] as u32;
        i += 1;
    }
    s
};

/// Qualidade (escala IJG 1..=100) estimada pela tabela de quantização de luminância.
pub fn jpeg_quality(bytes: &[u8]) -> Option<u8> {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut pos = 2;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF {
            return None;
        }
        let marker = bytes[pos + 1];
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = u16::from_be_bytes([bytes[pos + 2], bytes[pos + 3]]) as usize;
        let seg = bytes.get(pos + 4..pos + 2 + len)?;
        if marker == 0xDB {
            let mut t = seg;
            while !t.is_empty() {
                let (prec, id) = (t[0] >> 4, t[0] & 0x0F);
                let n = if prec == 0 { 64 } else { 128 };
                let vals = t.get(1..1 + n)?;
                if id == 0 {
                    let sum: u32 = if prec == 0 {
                        vals.iter().map(|&v| v as u32).sum()
                    } else {
                        vals.chunks(2)
                            .map(|c| u16::from_be_bytes([c[0], c[1]]) as u32)
                            .sum()
                    };
                    let scale = sum as f64 * 100.0 / STD_LUMA_SUM as f64;
                    let q = if scale <= 100.0 {
                        (200.0 - scale) / 2.0
                    } else {
                        5000.0 / scale
                    };
                    return Some(q.round().clamp(1.0, 100.0) as u8);
                }
                t = &t[1 + n..];
            }
        }
        pos += 2 + len;
    }
    None
}

// ---------- escrita atômica ----------

static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

/// Grava `path` por um temporário na mesma pasta + `rename`: se `write` falhar, o original
/// fica intacto e o temporário é apagado. O modo (permissões) do original é preservado.
pub fn write_atomic(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> AppResult<()>,
) -> AppResult<()> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| AppError::Io("caminho sem nome de arquivo".into()))?;
    let tmp = dir.join(format!(
        ".{}.gvi-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mode = fs::metadata(path).ok().map(|m| m.permissions().mode());
    let result = (|| {
        // Regravando: o temporário nasce 0o600 (nunca mais aberto que o original) e recebe o
        // modo do original pelo handle. Arquivo novo: modo padrão (0o666 menos a umask).
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if mode.is_some() { 0o600 } else { 0o666 })
            .open(&tmp)?;
        write(&mut f)?;
        f.flush()?;
        if let Some(mode) = mode {
            f.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Grava os bytes já codificados de forma atômica.
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    write_atomic(path, |f| f.write_all(bytes).map_err(Into::into))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orientacao_vira_1_nos_dois_enderecamentos() {
        for le in [true, false] {
            let mut t = if le {
                b"II*\0".to_vec()
            } else {
                b"MM\0*".to_vec()
            };
            let p32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
            let p16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
            t.extend_from_slice(&p32(8));
            t.extend_from_slice(&p16(1));
            t.extend_from_slice(&p16(0x0112));
            t.extend_from_slice(&p16(3));
            t.extend_from_slice(&p32(1));
            t.extend_from_slice(&p16(6));
            t.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
            let out = exif_reset_orientation(&t);
            assert_eq!(&out[18..20], &p16(1));
            assert_eq!(out.len(), t.len());
        }
        assert_eq!(exif_reset_orientation(b"lixo"), b"lixo");
    }

    #[test]
    fn xmp_troca_so_o_dc_subject() {
        let orig = "<x><rdf:RDF><dc:title>T</dc:title><dc:subject><rdf:Bag><rdf:li>a</rdf:li></rdf:Bag></dc:subject></rdf:RDF></x>";
        let out = xmp_with_keywords(Some(orig), &["b & c".into()]);
        assert!(out.contains("<dc:title>T</dc:title>"));
        assert!(out.contains("<rdf:li>b &amp; c</rdf:li>"));
        assert!(!out.contains("<rdf:li>a</rdf:li>"));
    }

    #[test]
    fn iim_mantem_outros_campos() {
        let orig = [0x1C, 2, 120, 0, 2, b'o', b'i', 0x1C, 2, 25, 0, 1, b'x'];
        let out = iim_with_keywords(Some(&orig), &["y".into()]);
        assert!(
            out.windows(7)
                .any(|w| w == [0x1C, 2, 120, 0, 2, b'o', b'i'])
        );
        assert!(!out.windows(6).any(|w| w == [0x1C, 2, 25, 0, 1, b'x']));
        assert!(out.ends_with(&[0x1C, 2, 25, 0, 1, b'y']));
    }
}
