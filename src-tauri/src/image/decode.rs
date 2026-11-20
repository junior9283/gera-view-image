//! Decodificação de todos os formatos de leitura para RGBA8, com a orientação EXIF aplicada.
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage,
    metadata::Orientation,
};
use std::{
    io::Cursor,
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
};

/// Imagem decodificada: quadros/páginas já orientados e metadados crus do arquivo.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub frames: Vec<RgbaImage>,
    /// Um por quadro (0 para imagens estáticas).
    pub delays_ms: Vec<u32>,
    pub format: SourceFormat,
    pub icc: Option<Vec<u8>>,
    /// Bloco EXIF começando no cabeçalho TIFF (`II*\0`/`MM\0*`).
    pub exif: Option<Vec<u8>>,
    pub dpi: Option<(f32, f32)>,
}

impl Decoded {
    pub fn single(img: RgbaImage, format: SourceFormat) -> Self {
        Decoded {
            frames: vec![img],
            delays_ms: vec![0],
            format,
            icc: None,
            exif: None,
            dpi: None,
        }
    }

    pub fn bytes(&self) -> usize {
        self.frames.iter().map(|f| f.as_raw().len()).sum()
    }
}

/// Lado maior em que um SVG é rasterizado.
pub const SVG_RASTER_SIDE: f32 = 2048.0;

const RAW_EXTS: &[&str] = &[
    "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "pef",
    "srw", "erf", "3fr", "iiq", "mef", "mos", "kdc", "dcr", "rwl", "x3f",
];

fn ext_format(ext: &str) -> Option<SourceFormat> {
    use SourceFormat::*;
    Some(match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" => Jpeg,
        "png" => Png,
        "gif" => Gif,
        "bmp" | "dib" => Bmp,
        "tif" | "tiff" => Tiff,
        "webp" => Webp,
        "heic" | "heif" | "hif" => Heic,
        "avif" => Avif,
        "ico" => Ico,
        "svg" => Svg,
        "psd" | "psb" => Psd,
        "tga" | "icb" | "vda" | "vst" => Tga,
        e if RAW_EXTS.contains(&e) => Raw,
        _ => return None,
    })
}

fn lower_ext(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Formato esperado pela extensão do arquivo.
pub fn format_from_path(path: &Path) -> Option<SourceFormat> {
    ext_format(&lower_ext(path))
}

/// Extensões que a pasta lista e o app abre.
pub fn is_supported_path(path: &Path) -> bool {
    ext_format(&lower_ext(path)).is_some()
}

/// Formato pelo conteúdo (assinatura); a extensão só decide o que não tem assinatura
/// (TGA, SVG) e separa RAW baseado em TIFF.
pub fn detect_format(path: &Path, head: &[u8]) -> Option<SourceFormat> {
    use SourceFormat::*;
    let by_ext = ext_format(&lower_ext(path));
    let starts = |sig: &[u8]| head.starts_with(sig);
    let sniffed = if starts(&[0xFF, 0xD8, 0xFF]) {
        Some(Jpeg)
    } else if starts(b"\x89PNG\r\n\x1a\n") {
        Some(Png)
    } else if starts(b"GIF8") {
        Some(Gif)
    } else if starts(b"BM") {
        Some(Bmp)
    } else if starts(b"II*\0") || starts(b"MM\0*") || starts(b"IIRO") || starts(b"IIU\0") {
        Some(if by_ext == Some(Raw) { Raw } else { Tiff })
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some(Webp)
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" {
        match &head[8..12] {
            b"avif" | b"avis" => Some(Avif),
            b"crx " => Some(Raw),
            _ => Some(Heic),
        }
    } else if starts(&[0, 0, 1, 0]) {
        Some(Ico)
    } else if starts(b"8BPS") {
        Some(Psd)
    } else {
        None
    };
    sniffed.or(match by_ext {
        Some(Tga) => Some(Tga),
        Some(Svg) if looks_like_svg(head) => Some(Svg),
        Some(Raw) => Some(Raw), // RAWs sem assinatura TIFF (RAF, X3F...): o rawler decide.
        _ => None,
    })
}

fn looks_like_svg(head: &[u8]) -> bool {
    let txt = String::from_utf8_lossy(&head[..head.len().min(4096)]);
    txt.contains("<svg") || (txt.trim_start().starts_with("<?xml") && !txt.contains("<html"))
}

/// Decodifica o arquivo inteiro (todos os quadros/páginas).
pub fn decode(path: &Path) -> AppResult<Decoded> {
    let bytes = std::fs::read(path)?;
    decode_bytes(path, &bytes)
}

/// Igual a [`decode`], com os bytes já lidos (`path` serve para extensão e recursos do SVG).
pub fn decode_bytes(path: &Path, bytes: &[u8]) -> AppResult<Decoded> {
    let format = detect_format(path, bytes).ok_or_else(|| {
        if ext_format(&lower_ext(path)).is_some() {
            AppError::Corrupt("conteúdo não corresponde a nenhum formato de imagem".into())
        } else {
            AppError::Unsupported(format!("formato não suportado: {}", path.display()))
        }
    })?;
    guarded(|| decode_format(path, bytes, format))
}

/// Decodificadores de terceiros podem entrar em pânico com arquivos malformados:
/// isso vira `Corrupt` só neste documento (o perfil release usa `panic = "unwind"`).
fn guarded<T>(f: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| {
        Err(AppError::Corrupt(
            "o decodificador falhou neste arquivo".into(),
        ))
    })
}

fn decode_format(path: &Path, bytes: &[u8], format: SourceFormat) -> AppResult<Decoded> {
    use SourceFormat::*;
    let mut d = match format {
        Jpeg => decode_image_crate(bytes, ImageFormat::Jpeg, format),
        Png => decode_image_crate(bytes, ImageFormat::Png, format),
        Bmp => decode_image_crate(bytes, ImageFormat::Bmp, format),
        Ico => decode_image_crate(bytes, ImageFormat::Ico, format),
        Tga => decode_image_crate(bytes, ImageFormat::Tga, format),
        Gif => decode_gif(bytes),
        Webp => decode_webp(bytes),
        Tiff => {
            decode_tiff(bytes).or_else(|_| decode_image_crate(bytes, ImageFormat::Tiff, format))
        }
        Heic | Avif => decode_heif(bytes, format),
        Svg => decode_svg(path, bytes),
        Psd => decode_psd(bytes),
        Raw => decode_raw(bytes),
    }?;
    if d.dpi.is_none() {
        d.dpi = match format {
            Jpeg => jfif_dpi(bytes),
            Png => png_dpi(bytes),
            _ => None,
        };
    }
    Ok(d)
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_alloc = Some(4 << 30); // 4 GiB: PNG de 100 MP+ cabe; arquivos absurdos falham com erro.
    l
}

fn decode_image_crate(bytes: &[u8], fmt: ImageFormat, format: SourceFormat) -> AppResult<Decoded> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), fmt);
    reader.limits(limits());
    let mut dec = reader.into_decoder()?;
    let orientation = dec.orientation().unwrap_or(Orientation::NoTransforms);
    let icc = dec.icc_profile().ok().flatten();
    let exif = dec.exif_metadata().ok().flatten();
    let mut img = DynamicImage::from_decoder(dec)?;
    img.apply_orientation(orientation);
    Ok(Decoded {
        icc,
        exif,
        ..Decoded::single(img.into_rgba8(), format)
    })
}

fn frames_of<'a>(frames: ::image::Frames<'a>, format: SourceFormat) -> AppResult<Decoded> {
    let frames = frames.collect_frames()?;
    if frames.is_empty() {
        return Err(AppError::Corrupt("animação sem quadros".into()));
    }
    let delays_ms = frames
        .iter()
        .map(|f| {
            let (n, d) = f.delay().numer_denom_ms();
            n.checked_div(d).unwrap_or(0)
        })
        .collect();
    Ok(Decoded {
        frames: frames.into_iter().map(|f| f.into_buffer()).collect(),
        delays_ms,
        format,
        icc: None,
        exif: None,
        dpi: None,
    })
}

fn decode_gif(bytes: &[u8]) -> AppResult<Decoded> {
    let dec = ::image::codecs::gif::GifDecoder::new(Cursor::new(bytes))?;
    frames_of(dec.into_frames(), SourceFormat::Gif)
}

fn decode_webp(bytes: &[u8]) -> AppResult<Decoded> {
    let dec = ::image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))?;
    if dec.has_animation() {
        frames_of(dec.into_frames(), SourceFormat::Webp)
    } else {
        decode_image_crate(bytes, ImageFormat::WebP, SourceFormat::Webp)
    }
}

/// TIFF com todas as páginas (a crate `image` só lê a primeira).
fn decode_tiff(bytes: &[u8]) -> AppResult<Decoded> {
    use tiff::{
        ColorType as C,
        decoder::{Decoder, DecodingResult as R, Limits as TL},
        tags::Tag,
    };
    let map = |e: tiff::TiffError| AppError::corrupt(e);
    let mut dec = Decoder::new(Cursor::new(bytes))
        .map_err(map)?
        .with_limits(TL::unlimited());
    let mut frames = Vec::new();
    let mut icc = None;
    let mut dpi = None;
    loop {
        let (w, h) = dec.dimensions().map_err(map)?;
        let color = dec.colortype().map_err(map)?;
        let orientation = dec.find_tag_unsigned::<u8>(Tag::Orientation).ok().flatten();
        if frames.is_empty() {
            icc = dec.get_tag_u8_vec(Tag::IccProfile).ok();
            dpi = tiff_dpi(&mut dec);
        }
        let to8 = |v: Vec<u16>| v.into_iter().map(|x| (x >> 8) as u8).collect::<Vec<u8>>();
        let (data, channels) = match (dec.read_image().map_err(map)?, color) {
            (R::U8(v), C::Gray(8)) => (v, 1),
            (R::U8(v), C::GrayA(8)) => (v, 2),
            (R::U8(v), C::RGB(8)) => (v, 3),
            (R::U8(v), C::RGBA(8)) => (v, 4),
            (R::U16(v), C::Gray(16)) => (to8(v), 1),
            (R::U16(v), C::GrayA(16)) => (to8(v), 2),
            (R::U16(v), C::RGB(16)) => (to8(v), 3),
            (R::U16(v), C::RGBA(16)) => (to8(v), 4),
            (_, c) => return Err(AppError::Unsupported(format!("TIFF {c:?}"))),
        };
        let mut img = match channels {
            1 => DynamicImage::ImageLuma8(
                ::image::GrayImage::from_raw(w, h, data).ok_or_else(short)?,
            ),
            2 => DynamicImage::ImageLumaA8(
                ::image::GrayAlphaImage::from_raw(w, h, data).ok_or_else(short)?,
            ),
            3 => {
                DynamicImage::ImageRgb8(::image::RgbImage::from_raw(w, h, data).ok_or_else(short)?)
            }
            _ => DynamicImage::ImageRgba8(RgbaImage::from_raw(w, h, data).ok_or_else(short)?),
        };
        if let Some(o) = orientation.and_then(Orientation::from_exif) {
            img.apply_orientation(o);
        }
        frames.push(img.into_rgba8());
        if !dec.more_images() {
            break;
        }
        dec.next_image().map_err(map)?;
    }
    let n = frames.len();
    Ok(Decoded {
        frames,
        delays_ms: vec![0; n],
        format: SourceFormat::Tiff,
        icc,
        exif: None,
        dpi,
    })
}

fn short() -> AppError {
    AppError::Corrupt("dados de pixel incompletos".into())
}

fn tiff_dpi<R: std::io::Read + std::io::Seek>(
    dec: &mut tiff::decoder::Decoder<R>,
) -> Option<(f32, f32)> {
    use tiff::{decoder::ifd::Value, tags::Tag};
    let rational = |v: Value| match v {
        Value::Rational(n, d) if d != 0 => Some(n as f32 / d as f32),
        Value::Short(s) => Some(s as f32),
        Value::Unsigned(u) => Some(u as f32),
        _ => None,
    };
    let x = rational(dec.find_tag(Tag::XResolution).ok()??)?;
    let y = rational(dec.find_tag(Tag::YResolution).ok()??).unwrap_or(x);
    // ResolutionUnit: 2 = polegada (padrão), 3 = centímetro.
    let k = if dec
        .find_tag_unsigned::<u16>(Tag::ResolutionUnit)
        .ok()
        .flatten()
        == Some(3)
    {
        2.54
    } else {
        1.0
    };
    Some((x * k, y * k))
}

fn decode_heif(bytes: &[u8], format: SourceFormat) -> AppResult<Decoded> {
    use libheif_rs::{ColorSpace, HeifContext, HeifErrorCode as E, ItemId, LibHeif, RgbChroma};
    let map = |e: libheif_rs::HeifError| match e.code {
        E::UnsupportedFileType | E::UnsupportedFeature | E::PluginLoadingError => {
            AppError::Unsupported(e.message)
        }
        _ => AppError::Corrupt(e.message),
    };
    let lib = LibHeif::new();
    let ctx = HeifContext::read_from_bytes(bytes).map_err(map)?;
    let handle = ctx.primary_image_handle().map_err(map)?;
    // O libheif já aplica as transformações do contêiner (irot/imir): não há EXIF a aplicar.
    let img = lib
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgba), None)
        .map_err(map)?;
    let (w, h) = (img.width(), img.height());
    let planes = img.planes();
    let plane = planes.interleaved.ok_or_else(short)?;
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for y in 0..h as usize {
        let start = y * plane.stride;
        out.extend_from_slice(
            plane
                .data
                .get(start..start + w as usize * 4)
                .ok_or_else(short)?,
        );
    }
    let mut ids: Vec<ItemId> = vec![0; 1];
    let exif = (handle.metadata_block_ids(&mut ids, b"Exif") > 0)
        .then(|| handle.metadata(ids[0]).ok())
        .flatten()
        // O bloco Exif do HEIF começa com um deslocamento u32 BE até o cabeçalho TIFF.
        .and_then(|m| {
            let off = u32::from_be_bytes(m.get(..4)?.try_into().ok()?) as usize;
            m.get(4 + off..).map(<[u8]>::to_vec)
        });
    Ok(Decoded {
        icc: handle.color_profile_raw().map(|p| p.data),
        exif,
        ..Decoded::single(RgbaImage::from_raw(w, h, out).ok_or_else(short)?, format)
    })
}

fn svg_fontdb() -> std::sync::Arc<resvg::usvg::fontdb::Database> {
    static DB: std::sync::OnceLock<std::sync::Arc<resvg::usvg::fontdb::Database>> =
        std::sync::OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        std::sync::Arc::new(db)
    })
    .clone()
}

fn decode_svg(path: &Path, bytes: &[u8]) -> AppResult<Decoded> {
    use resvg::{tiny_skia, usvg};
    let mut opt = usvg::Options {
        resources_dir: path.parent().map(Path::to_path_buf),
        ..Default::default()
    };
    // Carregar as fontes do sistema custa caro: só quando o SVG tem texto.
    if bytes.windows(5).any(|w| w == b"<text") {
        opt.fontdb = svg_fontdb();
    }
    let tree = usvg::Tree::from_data(bytes, &opt).map_err(AppError::corrupt)?;
    let size = tree.size();
    let scale = SVG_RASTER_SIDE / size.width().max(size.height());
    let (w, h) = (
        (size.width() * scale).round().max(1.0) as u32,
        (size.height() * scale).round().max(1.0) as u32,
    );
    let mut pixmap =
        tiny_skia::Pixmap::new(w, h).ok_or_else(|| AppError::Corrupt("SVG sem tamanho".into()))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let data = pixmap
        .pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect();
    Ok(Decoded::single(
        RgbaImage::from_raw(w, h, data).ok_or_else(short)?,
        SourceFormat::Svg,
    ))
}

fn decode_psd(bytes: &[u8]) -> AppResult<Decoded> {
    let psd = psd::Psd::from_bytes(bytes).map_err(AppError::corrupt)?;
    let img = RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or_else(short)?;
    Ok(Decoded::single(img, SourceFormat::Psd))
}

/// RAW com a revelação padrão do `rawler` (demosaico, balanço de branco, sRGB).
fn decode_raw(bytes: &[u8]) -> AppResult<Decoded> {
    use rawler::{imgop::develop::RawDevelop, rawsource::RawSource};
    let src = RawSource::new_from_slice(bytes);
    let raw = rawler::decode(&src, &Default::default())
        .map_err(|e| AppError::Unsupported(e.to_string()))?;
    let orientation = Orientation::from_exif(raw.orientation.to_u16() as u8);
    let mut img = RawDevelop::default()
        .develop_intermediate(&raw)
        .map_err(AppError::corrupt)?
        .to_dynamic_image()
        .ok_or_else(short)?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Ok(Decoded::single(img.into_rgba8(), SourceFormat::Raw))
}

/// Densidade do segmento JFIF (APP0), se em polegadas ou centímetros.
fn jfif_dpi(b: &[u8]) -> Option<(f32, f32)> {
    let app0 = b.get(2..20)?;
    if app0[0] != 0xFF || app0[1] != 0xE0 || &app0[4..9] != b"JFIF\0" {
        return None;
    }
    let (unit, x, y) = (
        app0[11],
        u16::from_be_bytes([app0[12], app0[13]]),
        u16::from_be_bytes([app0[14], app0[15]]),
    );
    match unit {
        1 => Some((x as f32, y as f32)),
        2 => Some((x as f32 * 2.54, y as f32 * 2.54)),
        _ => None,
    }
}

/// Chunk `pHYs` do PNG (unidade 1 = metro).
fn png_dpi(b: &[u8]) -> Option<(f32, f32)> {
    let mut i = 8;
    while i + 8 <= b.len() {
        let len = u32::from_be_bytes(b[i..i + 4].try_into().ok()?) as usize;
        let kind = &b[i + 4..i + 8];
        if kind == b"pHYs" {
            let d = b.get(i + 8..i + 17)?;
            let (x, y) = (
                u32::from_be_bytes(d[0..4].try_into().ok()?),
                u32::from_be_bytes(d[4..8].try_into().ok()?),
            );
            return (d[8] == 1).then_some((x as f32 * 0.0254, y as f32 * 0.0254));
        }
        if kind == b"IDAT" {
            return None;
        }
        i += 12 + len;
    }
    None
}

/// Prévia reduzida de um JPEG grande (escala DCT 1/2, 1/4 ou 1/8), já orientada.
pub struct JpegPreview {
    pub image: RgbaImage,
    /// Dimensões da imagem completa, já orientada.
    pub full_size: (u32, u32),
    pub icc: Option<Vec<u8>>,
    pub exif: Option<Vec<u8>>,
}

/// Dimensões de um JPEG sem decodificar (só o cabeçalho).
pub fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut d = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    d.read_info().ok()?;
    d.info().map(|i| (i.width as u32, i.height as u32))
}

/// Decodifica o JPEG na menor escala DCT cujo lado maior fique ≥ `min_long_side`.
pub fn decode_jpeg_preview(bytes: &[u8], min_long_side: u32) -> AppResult<JpegPreview> {
    guarded(|| jpeg_preview_inner(bytes, min_long_side))
}

fn jpeg_preview_inner(bytes: &[u8], min_long_side: u32) -> AppResult<JpegPreview> {
    use jpeg_decoder::{Decoder, PixelFormat as P};
    let mut d = Decoder::new(Cursor::new(bytes));
    d.read_info().map_err(AppError::corrupt)?;
    let info = d.info().ok_or_else(short)?;
    let (fw, fh) = (info.width as u32, info.height as u32);
    let k = (min_long_side as f32 / fw.max(fh) as f32).min(1.0);
    let req = |v: u32| ((v as f32 * k).ceil() as u32).clamp(1, u16::MAX as u32) as u16;
    d.scale(req(fw), req(fh)).map_err(AppError::corrupt)?;
    let pixels = d.decode().map_err(AppError::corrupt)?;
    let info = d.info().ok_or_else(short)?;
    let (w, h) = (info.width as u32, info.height as u32);
    let mut img = match info.pixel_format {
        P::RGB24 => {
            DynamicImage::ImageRgb8(::image::RgbImage::from_raw(w, h, pixels).ok_or_else(short)?)
        }
        P::L8 => {
            DynamicImage::ImageLuma8(::image::GrayImage::from_raw(w, h, pixels).ok_or_else(short)?)
        }
        P::L16 => {
            let v = pixels.as_chunks::<2>().0.iter().map(|c| c[0]).collect();
            DynamicImage::ImageLuma8(::image::GrayImage::from_raw(w, h, v).ok_or_else(short)?)
        }
        P::CMYK32 => {
            // Adobe grava CMYK invertido; a conversão simples basta para a prévia.
            let v = pixels
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|c| {
                    let k = c[3] as u16;
                    [c[0], c[1], c[2]].map(|x| (x as u16 * k / 255) as u8)
                })
                .collect();
            DynamicImage::ImageRgb8(::image::RgbImage::from_raw(w, h, v).ok_or_else(short)?)
        }
    };
    let exif = d.exif_data().map(<[u8]>::to_vec);
    let orientation = exif
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    img.apply_orientation(orientation);
    let swaps = matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    );
    Ok(JpegPreview {
        image: img.into_rgba8(),
        full_size: if swaps { (fh, fw) } else { (fw, fh) },
        icc: d.icc_profile(),
        exif,
    })
}

/// Ordem natural sem diferenciar maiúsculas nem acentos ("Ação 1" < "img2" < "img10").
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
    let key = |s: &str| {
        s.nfd()
            .filter(|c| !is_combining_mark(*c))
            .flat_map(char::to_lowercase)
            .collect::<Vec<char>>()
    };
    let (ka, kb) = (key(a), key(b));
    let (mut i, mut j) = (0, 0);
    while i < ka.len() && j < kb.len() {
        if ka[i].is_ascii_digit() && kb[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < ka.len() && ka[i].is_ascii_digit() {
                i += 1;
            }
            while j < kb.len() && kb[j].is_ascii_digit() {
                j += 1;
            }
            let na: String = ka[si..i]
                .iter()
                .collect::<String>()
                .trim_start_matches('0')
                .into();
            let nb: String = kb[sj..j]
                .iter()
                .collect::<String>()
                .trim_start_matches('0')
                .into();
            let ord = na.len().cmp(&nb.len()).then_with(|| na.cmp(&nb));
            if ord.is_ne() {
                return ord;
            }
        } else {
            let ord = ka[i].cmp(&kb[j]);
            if ord.is_ne() {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }
    (ka.len() - i).cmp(&(kb.len() - j)).then_with(|| a.cmp(b))
}

/// Imagens suportadas da pasta (ou da pasta do arquivo), em ordem natural, caminhos completos.
pub fn folder_images(path: &Path) -> AppResult<Vec<String>> {
    let dir = if path.is_dir() {
        path
    } else {
        path.parent()
            .ok_or_else(|| AppError::NotFound(path.display().to_string()))?
    };
    let mut files: Vec<(String, String)> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file() || t.is_symlink()))
        .map(|e| e.path())
        .filter(|p| is_supported_path(p) && p.is_file())
        .map(|p| {
            (
                p.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                p.to_string_lossy().into_owned(),
            )
        })
        .collect();
    files.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    Ok(files.into_iter().map(|(_, p)| p).collect())
}
