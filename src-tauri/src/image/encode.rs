//! Codificação para Salvar/Exportar: formatos, metadados levados junto e escrita atômica.
//! HEIC e JPEG 2000 ficam em `encode_heic.rs` e `encode_jp2.rs`.
use super::{
    container::{self, TiffMeta},
    encode_heic, encode_jp2, encode_psd, icc, pdf,
    raster::Raster,
};
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::{
    DynamicImage, ImageEncoder,
    codecs::{
        avif::AvifEncoder,
        bmp::BmpEncoder,
        gif::GifEncoder,
        ico::IcoEncoder,
        jpeg::{JpegEncoder, PixelDensity},
        png::{CompressionType, FilterType, PngEncoder},
        tga::TgaEncoder,
        webp::WebPEncoder,
    },
};
use serde::{Deserialize, Serialize};
use std::{
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
    Pdf,
    Gif,
    Ico,
    Tga,
    /// Photoshop achatado: só a imagem composta, sem camadas.
    Psd,
}

/// Compressão do TIFF (todas sem perdas). LZW e Deflate usam o preditor horizontal.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TiffCompression {
    #[default]
    None,
    Lzw,
    Packbits,
    Deflate,
}

impl ExportFormat {
    fn keeps_alpha(self) -> bool {
        use ExportFormat::*;
        matches!(
            self,
            Png | Tiff | Webp | Avif | Exr | Heic | Jp2 | Pdf | Gif | Ico | Tga | Psd
        )
    }

    /// O codificador grava o perfil ICC da imagem no arquivo. O PDF leva sempre o sRGB, e os
    /// outros não têm onde guardar (ou o codificador não grava).
    fn embeds_icc(self) -> bool {
        use ExportFormat::*;
        !matches!(self, Avif | Exr | Pdf | Gif | Ico | Tga)
    }

    /// Só guarda a resolução (ppp) no EXIF: sem EXIF no original, ganha um com ela.
    fn dpi_in_exif(self) -> bool {
        use ExportFormat::*;
        matches!(self, Webp | Avif | Heic)
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
            SourceFormat::Heic => ExportFormat::Heic,
            SourceFormat::Jp2 => ExportFormat::Jp2,
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
            ExportFormat::Jp2 => SourceFormat::Jp2,
            ExportFormat::Gif => SourceFormat::Gif,
            ExportFormat::Ico => SourceFormat::Ico,
            ExportFormat::Tga => SourceFormat::Tga,
            ExportFormat::Psd => SourceFormat::Psd,
            // Sem leitura própria: o documento fica sem Salvar (vai para Exportar).
            ExportFormat::Exr | ExportFormat::Pdf => SourceFormat::Raw,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: ExportFormat,
    /// 1..=100. `None`: JPEG 90, WebP e PDF sem perdas, AVIF 80.
    pub quality: Option<u8>,
    #[serde(default = "yes")]
    pub alpha: bool,
    /// PNG/TIFF em 16 bits por canal (pixels de 8 bits são expandidos).
    #[serde(default)]
    pub depth16: bool,
    #[serde(default)]
    pub strip_metadata: bool,
    #[serde(default)]
    pub resize: Option<(u32, u32)>,
    /// Perfil de saída (Lote 1): os pixels são convertidos do perfil da imagem para este e ele é
    /// embutido no arquivo, mesmo sem metadados. `None` = manter o perfil da imagem.
    /// Valores: os ids de `icc::BUILTIN` ou o caminho de um .icc do sistema; os formatos sem perfil
    /// (`embeds_icc`) só aceitam sRGB (manter um perfil que não seja sRGB também converte para sRGB).
    #[serde(default)]
    pub color_profile: Option<String>,
    #[serde(default)]
    pub tiff_compression: TiffCompression,
    /// OpenEXR em 16 bits (half) por canal, em vez de 32 (float).
    #[serde(default)]
    pub exr_half: bool,
    /// Resolução gravada (ppp); `None` = a do documento. No PDF, define o tamanho da página.
    #[serde(default)]
    pub dpi: Option<f32>,
}

impl ExportOptions {
    /// As opções padrão do formato.
    pub fn new(format: ExportFormat) -> Self {
        ExportOptions {
            format,
            quality: None,
            alpha: true,
            depth16: false,
            strip_metadata: false,
            resize: None,
            color_profile: None,
            tiff_compression: TiffCompression::None,
            exr_half: false,
            dpi: None,
        }
    }

    /// Grava mais de 8 bits por canal: vale refazer os pixels em 16 bits a partir do original.
    pub fn deep(&self) -> bool {
        match self.format {
            ExportFormat::Png | ExportFormat::Tiff => self.depth16,
            ExportFormat::Exr => true,
            _ => false,
        }
    }
}

/// ppp aceitos ao gravar (fora disto o valor é puxado para o limite).
const DPI_MIN: f32 = 1.0;
const DPI_MAX: f32 = 10_000.0;
const ICO_MAX: u32 = 256;

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
    /// Registros IPTC-IIM crus do original (JPEG, TIFF).
    pub iptc: Option<Vec<u8>>,
    /// Pacote XMP do original (JPEG com o estendido reunido, PNG, TIFF, WebP).
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

/// Codifica `img` (RGBA8 ou RGBA16, já com todas as operações) conforme `opts`.
pub fn encode<'a>(
    img: impl Into<Raster<'a>>,
    opts: &ExportOptions,
    meta: &MetaCarry,
) -> AppResult<Vec<u8>> {
    let fmt = opts.format;
    let img: Raster = match opts.resize {
        Some((w, h)) if w == 0 || h == 0 => {
            return Err(AppError::Unsupported("tamanho zero".into()));
        }
        Some((w, h)) => img.into().resized(w, h),
        None => img.into(),
    };
    let img = match (fmt, img.dimensions()) {
        // O ICO vai até 256×256.
        (ExportFormat::Ico, (w, h)) if w.max(h) > ICO_MAX => {
            let k = ICO_MAX as f64 / w.max(h) as f64;
            let side = |v: u32| ((v as f64 * k).round() as u32).max(1);
            img.resized(side(w), side(h))
        }
        _ => img,
    };
    // Só um perfil RGB descreve os pixels; CMYK e cinza já viraram RGB na decodificação.
    let src = meta.icc.as_deref().filter(|p| container::icc_is_rgb(p));
    let target = match &opts.color_profile {
        Some(id) if !fmt.embeds_icc() && id != icc::SRGB => {
            return Err(AppError::Unsupported(format!(
                "{fmt:?} não leva perfil de cor: só sRGB"
            )));
        }
        Some(id) => Some(icc::profile_bytes(id)?),
        // O arquivo vai sair sem perfil: em sRGB, as cores continuam certas.
        None if (opts.strip_metadata || !fmt.embeds_icc())
            && src.is_some_and(|s| icc::convertible(s, icc::srgb_icc())) =>
        {
            Some(icc::profile_bytes(icc::SRGB)?)
        }
        None => None,
    };
    let img = match &target {
        Some(dst) => icc::convert_raster(img, src.unwrap_or(icc::srgb_icc()), dst)?,
        None => img,
    };
    let out_icc = match (&opts.color_profile, &target) {
        (Some(_), Some(dst)) => Some(dst.to_vec()),
        (None, None) if !opts.strip_metadata => src.map(<[u8]>::to_vec),
        _ => None,
    };
    let new_dpi = opts
        .dpi
        .filter(|d| d.is_finite())
        .map(|d| d.clamp(DPI_MIN, DPI_MAX));
    let dpi = new_dpi.map(|d| (d, d)).or(meta.dpi);
    let mut meta = if opts.strip_metadata {
        MetaCarry {
            dpi,
            icc: out_icc,
            ..MetaCarry::default()
        }
    } else {
        MetaCarry {
            exif: meta.exif.as_deref().map(|e| {
                container::exif_set_pixel_dims(&exif_reset_orientation(e), img.dimensions())
            }),
            icc: out_icc,
            dpi,
            ..meta.clone()
        }
    };
    // A resolução nova também vai para o EXIF (leitores que olham primeiro para ele).
    if let Some(d) = new_dpi
        && (meta.exif.is_some() || fmt.dpi_in_exif())
    {
        meta.exif = container::exif_with_dpi(meta.exif.as_deref(), d).or(meta.exif);
    }
    let with_alpha = opts.alpha && fmt.keeps_alpha() && img.has_alpha();
    let pixels = img.into_pixels(with_alpha, opts.deep());
    let xmp = match &meta.iptc_keywords {
        Some(k) => Some(xmp_with_keywords(meta.xmp.as_deref(), k)),
        None => meta.xmp.clone(),
    };
    let iptc = match &meta.iptc_keywords {
        Some(k) => Some(iim_with_keywords(meta.iptc.as_deref(), k)),
        None => meta.iptc.clone(),
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
            out = tiff(&pixels, opts.tiff_compression)?;
            let tm = TiffMeta {
                exif: meta.exif.as_deref(),
                iptc: iptc.as_deref(),
                xmp: xmp.as_deref(),
                icc: meta.icc.as_deref(),
                dpi: meta.dpi,
            };
            out = container::tiff_with_meta(&out, &tm).unwrap_or(out);
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
            // O ravif/avif-serialize só gravam EXIF: ICC e XMP ficam de fora no AVIF.
            if let Some(exif) = &meta.exif {
                let _ = e.set_exif_metadata(exif.clone());
            }
            pixels.write_with_encoder(e).map_err(enc_err)?;
        }
        ExportFormat::Bmp => {
            pixels
                .write_with_encoder(BmpEncoder::new(&mut out))
                .map_err(enc_err)?;
            if let Some(icc) = &meta.icc {
                out = container::bmp_with_icc(&out, icc).unwrap_or(out);
            }
            if let Some(dpi) = meta.dpi {
                bmp_set_dpi(&mut out, dpi);
            }
        }
        ExportFormat::Exr => {
            out = exr(&pixels, opts.exr_half, meta.dpi)?;
        }
        ExportFormat::Pdf => {
            let mut doc = pdf::Pdf::new();
            doc.add_page(&pixels, opts.quality, meta.dpi)?;
            out = doc.finish();
        }
        ExportFormat::Gif => {
            let px = binary_alpha(pixels.into_rgba8());
            GifEncoder::new(&mut out)
                .encode(&px, px.width(), px.height(), ::image::ExtendedColorType::Rgba8)
                .map_err(enc_err)?;
        }
        // Sempre RGBA: leitores de ICO (e o da crate `image`) recusam PNG sem alfa.
        ExportFormat::Ico => DynamicImage::ImageRgba8(pixels.into_rgba8())
            .write_with_encoder(IcoEncoder::new(&mut out))
            .map_err(enc_err)?,
        ExportFormat::Tga => pixels
            .write_with_encoder(TgaEncoder::new(&mut out))
            .map_err(enc_err)?,
        ExportFormat::Psd => {
            out = encode_psd::encode(&pixels, &meta, iptc.as_deref(), xmp.as_deref())?;
        }
        ExportFormat::Heic => out = encode_heic::encode(&pixels, opts.quality, &meta)?,
        ExportFormat::Jp2 => out = encode_jp2::encode(&pixels, opts.quality, &meta)?,
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

/// TIFF sem metadados (entram depois, com `tiff_with_meta`).
fn tiff(px: &DynamicImage, compression: TiffCompression) -> AppResult<Vec<u8>> {
    use ::tiff::{
        encoder::{Compression, TiffEncoder, colortype as ct},
        tags::Predictor,
    };
    let (compression, predictor) = match compression {
        TiffCompression::None => (Compression::Uncompressed, Predictor::None),
        TiffCompression::Packbits => (Compression::Packbits, Predictor::None),
        TiffCompression::Lzw => (Compression::Lzw, Predictor::Horizontal),
        TiffCompression::Deflate => {
            (Compression::Deflate(Default::default()), Predictor::Horizontal)
        }
    };
    let mut c = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut c)
        .map_err(enc_err)?
        .with_compression(compression)
        .with_predictor(predictor);
    let (w, h) = (px.width(), px.height());
    match px {
        DynamicImage::ImageRgba16(i) => e.write_image::<ct::RGBA16>(w, h, i.as_raw()),
        DynamicImage::ImageRgb16(i) => e.write_image::<ct::RGB16>(w, h, i.as_raw()),
        DynamicImage::ImageRgba8(i) => e.write_image::<ct::RGBA8>(w, h, i.as_raw()),
        other => e.write_image::<ct::RGB8>(w, h, other.to_rgb8().as_raw()),
    }
    .map_err(enc_err)?;
    Ok(c.into_inner())
}

/// OpenEXR com as primárias do sRGB em luz linear (desfaz a curva sRGB), em half ou float.
fn exr(px: &DynamicImage, half: bool, dpi: Option<(f32, f32)>) -> AppResult<Vec<u8>> {
    use ::exr::prelude::{
        Encoding, Image, Layer, LayerAttributes, SpecificChannels, Vec2, WritableImage, f16,
    };
    // Um valor por código de 16 bits (os de 8 bits chegam expandidos).
    let lut: Vec<f32> = (0..=u16::MAX)
        .map(|v| {
            let c = v as f32 / u16::MAX as f32;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect();
    let size = (px.width() as usize, px.height() as usize);
    let attributes = LayerAttributes {
        horizontal_density: dpi.map(|(x, _)| x),
        ..Default::default()
    };
    // Um ramo por tipo de amostra e de canais: o tipo do arquivo sai do tipo da função.
    macro_rules! write_exr {
        ($channels:ident, $pixel:expr) => {{
            let channels = SpecificChannels::$channels($pixel);
            let mut c = Cursor::new(Vec::new());
            Image::from_layer(Layer::new(size, attributes, Encoding::default(), channels))
                .write()
                .to_buffered(&mut c)
                .map_err(enc_err)?;
            Ok(c.into_inner())
        }};
    }
    let h = f16::from_f32;
    match px {
        DynamicImage::ImageRgba16(i) => {
            let at = |p: Vec2<usize>| {
                let [r, g, b, a] = i.get_pixel(p.x() as u32, p.y() as u32).0;
                let l = |v: u16| lut[v as usize];
                (l(r), l(g), l(b), a as f32 / u16::MAX as f32)
            };
            if !half {
                return write_exr!(rgba, at);
            }
            write_exr!(rgba, |p: Vec2<usize>| {
                let (r, g, b, a) = at(p);
                (h(r), h(g), h(b), h(a))
            })
        }
        other => {
            let i = other.to_rgb16();
            let at = |p: Vec2<usize>| {
                let [r, g, b] = i.get_pixel(p.x() as u32, p.y() as u32).0;
                let l = |v: u16| lut[v as usize];
                (l(r), l(g), l(b))
            };
            if !half {
                return write_exr!(rgb, at);
            }
            write_exr!(rgb, |p: Vec2<usize>| {
                let (r, g, b) = at(p);
                (h(r), h(g), h(b))
            })
        }
    }
}

/// Transparência de 1 bit do GIF: menos da metade some; o resto fica opaco, composto sobre
/// branco (sem halo da cor de um pixel quase transparente).
fn binary_alpha(mut img: ::image::RgbaImage) -> ::image::RgbaImage {
    for p in img.pixels_mut() {
        let a = p[3] as u32;
        if a < 128 {
            p.0 = [0; 4];
        } else {
            let c = |v: u8| ((v as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
            p.0 = [c(p[0]), c(p[1]), c(p[2]), 255];
        }
    }
    img
}

/// `biXPelsPerMeter`/`biYPelsPerMeter` (mesma posição em todos os cabeçalhos de 40+ bytes).
fn bmp_set_dpi(bmp: &mut [u8], (x, y): (f32, f32)) {
    for (at, d) in [(38, x), (42, y)] {
        if let Some(b) = bmp.get_mut(at..at + 4) {
            b.copy_from_slice(&((d / 0.0254).round() as i32).to_le_bytes());
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

fn jpeg_segment(marker: u8, payload: &[u8]) -> Option<Vec<u8>> {
    let len = u16::try_from(payload.len() + 2).ok()?;
    let mut s = vec![0xFF, marker];
    s.extend_from_slice(&len.to_be_bytes());
    s.extend_from_slice(payload);
    Some(s)
}

/// Insere APP13 (IPTC) e APP1 (XMP, com o estendido se passar de 64 KB) depois dos APPn
/// que o codificador escreveu.
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
    for p in xmp.map(container::jpeg_xmp_payloads).unwrap_or_default() {
        extra.extend(jpeg_segment(0xE1, &p).unwrap_or_default());
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

    /// Perfil de saída: os pixels vão do perfil da imagem para o escolhido, que é embutido
    /// (também sem metadados). Sem escolha, os pixels e o perfil original ficam como estão.
    #[test]
    fn perfil_de_saida_converte_e_embute() {
        let p3 = icc::profile_bytes("display-p3").unwrap().to_vec();
        let srgb = icc::profile_bytes("srgb").unwrap().to_vec();
        let img = ::image::RgbaImage::from_pixel(3, 2, ::image::Rgba([200, 100, 50, 255]));
        let meta = MetaCarry {
            icc: Some(p3.clone()),
            ..MetaCarry::default()
        };
        let reread = |opts: &ExportOptions| {
            let png = encode(&img, opts, &meta).unwrap();
            let d = super::super::decode::decode_bytes(Path::new("x.png"), &png).unwrap();
            (d.frames[0].get_pixel(0, 0).0, d.icc)
        };
        let base = ExportOptions {
            format: ExportFormat::Png,
            quality: None,
            alpha: true,
            depth16: false,
            strip_metadata: false,
            resize: None,
            color_profile: None,
            ..ExportOptions::new(ExportFormat::Png)
        };
        assert_eq!(reread(&base), ([200, 100, 50, 255], Some(p3.clone())));
        for strip in [false, true] {
            let opts = ExportOptions {
                strip_metadata: strip,
                color_profile: Some("srgb".into()),
                ..base.clone()
            };
            let (px, icc) = reread(&opts);
            let want = [215, 93, 31];
            assert!(px[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= 2), "{px:?}");
            assert_eq!(icc.as_ref(), Some(&srgb), "strip={strip}");
        }
        let unknown = ExportOptions {
            color_profile: Some("nao-existe".into()),
            ..base
        };
        assert!(encode(&img, &unknown, &meta).is_err());
    }

    /// AVIF e EXR não levam perfil: manter um P3 grava sRGB, e outro destino é recusado.
    /// O mesmo vale para "Remover metadados", que tira o perfil.
    #[test]
    fn sem_perfil_no_arquivo_grava_srgb() {
        let img = ::image::RgbaImage::from_pixel(16, 16, ::image::Rgba([200, 100, 50, 255]));
        let opts = |format, strip_metadata, color_profile: Option<&str>| ExportOptions {
            format,
            quality: Some(100),
            alpha: false,
            depth16: false,
            strip_metadata,
            resize: None,
            color_profile: color_profile.map(Into::into),
            ..ExportOptions::new(ExportFormat::Png)
        };
        let near = |px: &[u8], want: [u8; 3], tol: u8| {
            assert!(px[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= tol), "{px:?}");
        };
        for (id, want) in [("display-p3", [215, 93, 31]), ("adobe-rgb", [227, 100, 42])] {
            let meta = MetaCarry {
                icc: Some(icc::profile_bytes(id).unwrap().to_vec()),
                ..MetaCarry::default()
            };
            for explicit in [None, Some("srgb")] {
                let exr = encode(&img, &opts(ExportFormat::Exr, false, explicit), &meta).unwrap();
                let exr = ::image::load_from_memory(&exr).unwrap().into_rgb32f();
                let enc = |c: f32| ((1.055 * c.powf(1.0 / 2.4) - 0.055) * 255.0).round() as u8;
                near(&exr.get_pixel(3, 3).0.map(enc), want, 2);
                let avif = encode(&img, &opts(ExportFormat::Avif, false, explicit), &meta).unwrap();
                let d = super::super::decode::decode_bytes(Path::new("x.avif"), &avif).unwrap();
                near(&d.frames[0].get_pixel(3, 3).0, want, 5);
                assert_eq!(d.icc, None);
            }
            let png = encode(&img, &opts(ExportFormat::Png, true, None), &meta).unwrap();
            let d = super::super::decode::decode_bytes(Path::new("x.png"), &png).unwrap();
            near(&d.frames[0].get_pixel(3, 3).0, want, 2);
            assert_eq!(d.icc, None);
            for format in [ExportFormat::Exr, ExportFormat::Avif] {
                for target in ["display-p3", "adobe-rgb"] {
                    let e = encode(&img, &opts(format, false, Some(target)), &meta).unwrap_err();
                    assert_eq!(e.code(), "unsupported");
                }
            }
        }
    }

    #[test]
    fn perfil_rgb_ilegivel_da_erro_so_se_for_converter() {
        let img = ::image::RgbaImage::from_pixel(2, 2, ::image::Rgba([1, 2, 3, 255]));
        let mut fake = vec![0u8; 132];
        fake[16..20].copy_from_slice(b"RGB ");
        let meta = MetaCarry {
            icc: Some(fake),
            ..MetaCarry::default()
        };
        let mut opts = ExportOptions {
            format: ExportFormat::Png,
            quality: None,
            alpha: true,
            depth16: false,
            strip_metadata: false,
            resize: None,
            color_profile: None,
            ..ExportOptions::new(ExportFormat::Png)
        };
        assert!(encode(&img, &opts, &meta).is_ok());
        opts.color_profile = Some("display-p3".into());
        assert!(encode(&img, &opts, &meta).is_err());
    }

    #[test]
    fn perfil_de_saida_em_16_bits() {
        let img = super::super::raster::Rgba16Image::from_pixel(2, 2, ::image::Rgba([65535, 0, 0, 65535]));
        let opts = ExportOptions {
            format: ExportFormat::Png,
            quality: None,
            alpha: true,
            depth16: true,
            strip_metadata: true,
            resize: None,
            color_profile: Some("display-p3".into()),
            ..ExportOptions::new(ExportFormat::Png)
        };
        let png = encode(&img, &opts, &MetaCarry::default()).unwrap();
        let d = ::image::load_from_memory(&png).unwrap().into_rgba16();
        let p = d.get_pixel(0, 0).0;
        let want = [234.0, 51.0, 35.0];
        assert!(p[..3].iter().zip(want).all(|(c, w)| (*c as f64 / 257.0 - w).abs() <= 2.0), "{p:?}");
    }

    // ---------- Lote 11 ----------

    fn reopen(name: &str, bytes: &[u8]) -> super::super::decode::Decoded {
        super::super::decode::decode_bytes(Path::new(name), bytes).unwrap()
    }

    /// Duas cores e três graus de transparência (cabe na paleta do GIF sem perdas).
    fn sprite() -> ::image::RgbaImage {
        ::image::RgbaImage::from_fn(40, 20, |x, y| match (x / 10, y / 10) {
            (0, _) => ::image::Rgba([0, 0, 0, 0]),
            (1, _) => ::image::Rgba([200, 0, 0, 64]),
            (2, _) => ::image::Rgba([200, 0, 0, 191]),
            (_, 0) => ::image::Rgba([10, 20, 30, 255]),
            _ => ::image::Rgba([240, 130, 5, 255]),
        })
    }

    #[test]
    fn ico_tga_e_psd_voltam_identicos() {
        let img = sprite();
        for (format, name) in
            [(ExportFormat::Ico, "a.ico"), (ExportFormat::Tga, "a.tga"), (ExportFormat::Psd, "a.psd")]
        {
            let out = encode(&img, &ExportOptions::new(format), &MetaCarry::default()).unwrap();
            assert_eq!(reopen(name, &out).frames[0], img, "{name}");
            // Sem alfa: composto sobre branco.
            let opts = ExportOptions { alpha: false, ..ExportOptions::new(format) };
            let d = reopen(name, &encode(&img, &opts, &MetaCarry::default()).unwrap());
            assert_eq!(d.frames[0].get_pixel(0, 0).0, [255; 4], "{name}");
        }
    }

    #[test]
    fn gif_tem_transparencia_de_um_bit_sem_halo() {
        let opts = ExportOptions::new(ExportFormat::Gif);
        let out = encode(&sprite(), &opts, &MetaCarry::default()).unwrap();
        assert!(out.starts_with(b"GIF89a"));
        let d = reopen("a.gif", &out);
        let at = |x, y| d.frames[0].get_pixel(x, y).0;
        assert_eq!((at(5, 5)[3], at(15, 5)[3]), (0, 0), "menos da metade some");
        assert_eq!(at(25, 5), [214, 64, 64, 255], "composto sobre branco");
        assert_eq!((at(35, 5), at(35, 15)), ([10, 20, 30, 255], [240, 130, 5, 255]));
    }

    #[test]
    fn ico_reduz_a_256() {
        let img = ::image::RgbaImage::new(1000, 400);
        let opts = ExportOptions::new(ExportFormat::Ico);
        let d = reopen("a.ico", &encode(&img, &opts, &MetaCarry::default()).unwrap());
        assert_eq!(d.frames[0].dimensions(), (256, 102));
    }

    #[test]
    fn tiff_com_cada_compressao() {
        let img = DynamicImage::ImageRgb8(super::super::test_util::gradiente(300, 200));
        let deep = img.to_rgba16();
        let mut sizes = Vec::new();
        for (compression, code) in [
            (TiffCompression::None, 1),
            (TiffCompression::Lzw, 5),
            (TiffCompression::Packbits, 32773),
            (TiffCompression::Deflate, 8),
        ] {
            let opts = ExportOptions {
                tiff_compression: compression,
                ..ExportOptions::new(ExportFormat::Tiff)
            };
            let meta = MetaCarry { dpi: Some((300.0, 300.0)), ..MetaCarry::default() };
            let out = encode(&img.to_rgba8(), &opts, &meta).unwrap();
            let d = reopen("a.tiff", &out);
            assert_eq!((&d.frames[0], d.dpi), (&img.to_rgba8(), meta.dpi), "{compression:?}");
            let tag = container::tiff_tag(&out, 259).unwrap();
            assert_eq!(u16::from_le_bytes([tag[0], tag[1]]), code, "{compression:?}");
            sizes.push(out.len());
            let opts16 = ExportOptions { depth16: true, ..opts };
            let back = ::image::load_from_memory(&encode(&deep, &opts16, &meta).unwrap()).unwrap();
            assert_eq!(back.to_rgba16(), deep, "16 bits, {compression:?}");
        }
        assert!(sizes[1] < sizes[0] / 2 && sizes[3] < sizes[0] / 2, "{sizes:?}");
    }

    #[test]
    fn exr_half_e_float() {
        use ::exr::prelude::{MetaData, SampleType};
        let img = ::image::RgbaImage::from_pixel(8, 6, ::image::Rgba([255, 188, 0, 128]));
        for (exr_half, want) in [(true, SampleType::F16), (false, SampleType::F32)] {
            let opts = ExportOptions {
                exr_half,
                dpi: Some(300.0),
                ..ExportOptions::new(ExportFormat::Exr)
            };
            let out = encode(&img, &opts, &MetaCarry::default()).unwrap();
            let meta = MetaData::read_from_buffered(Cursor::new(&out), false).unwrap();
            let h = &meta.headers[0];
            assert_eq!(h.channels.list.len(), 4);
            assert!(h.channels.list.iter().all(|c| c.sample_type == want), "half={exr_half}");
            assert_eq!(h.own_attributes.horizontal_density, Some(300.0));
            let px = ::image::load_from_memory(&out).unwrap().into_rgba32f().get_pixel(3, 3).0;
            let linear = [1.0, 0.5029, 0.0, 128.0 / 255.0];
            assert!(px.iter().zip(linear).all(|(a, b)| (a - b).abs() < 2e-3), "{px:?}");
        }
        // Origem de 16 bits: guarda mais níveis que 8 bits conseguem.
        let deep = super::super::raster::Rgba16Image::from_pixel(2, 2, ::image::Rgba([32800; 4]));
        let opts = ExportOptions::new(ExportFormat::Exr);
        let out = encode(&deep, &opts, &MetaCarry::default()).unwrap();
        let got = ::image::load_from_memory(&out).unwrap().into_rgba32f().get_pixel(0, 0).0[0];
        let c = 32800f32 / 65535.0;
        assert!((got - ((c + 0.055) / 1.055).powf(2.4)).abs() < 1e-6, "{got}");
    }

    #[test]
    fn resolucao_escolhida_vai_para_o_arquivo_e_o_exif() {
        let img = ::image::RgbaImage::from_pixel(16, 16, ::image::Rgba([9, 90, 200, 255]));
        let meta = MetaCarry {
            exif: container::exif_with_dpi(None, 72.0),
            dpi: Some((72.0, 72.0)),
            ..MetaCarry::default()
        };
        let exif_dpi = |exif: &[u8]| {
            let t = container::tiff_tag(exif, 282).unwrap();
            let n = |i: usize| u32::from_le_bytes(t[i..i + 4].try_into().unwrap()) as f32;
            n(0) / n(4)
        };
        for (format, name) in [
            (ExportFormat::Jpeg, "a.jpg"),
            (ExportFormat::Png, "a.png"),
            (ExportFormat::Tiff, "a.tiff"),
        ] {
            let opts = ExportOptions { dpi: Some(300.0), ..ExportOptions::new(format) };
            let d = reopen(name, &encode(&img, &opts, &meta).unwrap());
            let (x, y) = d.dpi.unwrap();
            assert!((x - 300.0).abs() < 0.1 && (y - 300.0).abs() < 0.1, "{name}: {x}");
            if format != ExportFormat::Tiff {
                assert_eq!(exif_dpi(&d.exif.unwrap()), 300.0, "{name}");
            }
            // Sem escolha, fica a do documento.
            let d = reopen(name, &encode(&img, &ExportOptions::new(format), &meta).unwrap());
            assert!((d.dpi.unwrap().0 - 72.0).abs() < 0.1, "{name}");
        }
        // Sem lugar próprio (nem EXIF no original): ganha um EXIF só com ela, até sem metadados.
        for strip_metadata in [false, true] {
            let opts = ExportOptions {
                dpi: Some(240.0),
                strip_metadata,
                ..ExportOptions::new(ExportFormat::Webp)
            };
            let d = reopen("a.webp", &encode(&img, &opts, &MetaCarry::default()).unwrap());
            assert_eq!(exif_dpi(&d.exif.unwrap()), 240.0);
        }
        let opts = ExportOptions { dpi: Some(254.0), ..ExportOptions::new(ExportFormat::Bmp) };
        let bmp = encode(&img, &opts, &MetaCarry::default()).unwrap();
        assert_eq!(&bmp[38..46], [10_000i32.to_le_bytes(), 10_000i32.to_le_bytes()].concat());
        // Fora da faixa ou inválida não quebra nem grava lixo.
        for (bad, want) in [(0.0, 1.0), (f32::NAN, 72.0), (1e9, 10_000.0)] {
            let opts = ExportOptions { dpi: Some(bad), ..ExportOptions::new(ExportFormat::Tiff) };
            let d = reopen("a.tiff", &encode(&img, &opts, &meta).unwrap());
            assert_eq!(d.dpi.unwrap().0, want);
        }
    }

    #[test]
    fn pdf_no_seletor_usa_a_resolucao() {
        let img = ::image::RgbaImage::from_pixel(600, 300, ::image::Rgba([1, 2, 3, 255]));
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        let opts = ExportOptions { dpi: Some(300.0), ..ExportOptions::new(ExportFormat::Pdf) };
        let out = encode(&img, &opts, &MetaCarry::default()).unwrap();
        assert!(out.starts_with(b"%PDF-"));
        assert!(text(&out).contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(!text(&out).contains("/DCTDecode"), "sem qualidade, sem perdas");
        let opts = ExportOptions { quality: Some(80), ..opts };
        let out = encode(&img, &opts, &MetaCarry::default()).unwrap();
        assert!(text(&out).contains("/DCTDecode"));
    }

    /// GIF, TGA, ICO e PDF não levam o perfil da imagem: saem em sRGB, e outro destino é recusado.
    #[test]
    fn formatos_novos_sem_perfil_saem_em_srgb() {
        use ExportFormat::*;
        let img = ::image::RgbaImage::from_pixel(16, 16, ::image::Rgba([200, 100, 50, 255]));
        let p3 = icc::profile_bytes("display-p3").unwrap().to_vec();
        let meta = MetaCarry { icc: Some(p3.clone()), ..MetaCarry::default() };
        for (format, name) in [(Gif, "a.gif"), (Tga, "a.tga"), (Ico, "a.ico")] {
            let d = reopen(name, &encode(&img, &ExportOptions::new(format), &meta).unwrap());
            let px = d.frames[0].get_pixel(3, 3).0;
            let near = px[..3].iter().zip([215, 93, 31]).all(|(a, b)| a.abs_diff(b) <= 2);
            assert!(near, "{name} {px:?}");
            assert_eq!(d.icc, None);
        }
        for format in [Gif, Tga, Ico, Pdf] {
            let opts = ExportOptions {
                color_profile: Some("adobe-rgb".into()),
                ..ExportOptions::new(format)
            };
            assert_eq!(encode(&img, &opts, &meta).unwrap_err().code(), "unsupported");
        }
        // O PSD leva o perfil e os pixels como estão.
        let out = encode(&img, &ExportOptions::new(Psd), &meta).unwrap();
        assert_eq!(reopen("a.psd", &out).frames[0].get_pixel(0, 0).0, [200, 100, 50, 255]);
        assert!(out.windows(p3.len()).any(|w| w == p3));
    }
}
