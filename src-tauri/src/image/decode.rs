//! Decodificação de todos os formatos de leitura para RGBA8, com a orientação EXIF aplicada.
use super::{cicp, hdr, icns, jxl, raster::Rgba16Image};
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage,
    metadata::{LoopCount, Orientation},
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
    /// Vezes que a animação toca no total; 0 = para sempre (também quando o arquivo não declara).
    pub plays: u32,
    pub format: SourceFormat,
    pub icc: Option<Vec<u8>>,
    /// Bloco EXIF começando no cabeçalho TIFF (`II*\0`/`MM\0*`), exatamente como no arquivo.
    /// Atenção: a tag Orientation continua com o valor ORIGINAL, mas `frames` já está girado.
    /// Quem gravar este EXIF num arquivo novo deve reescrever Orientation = 1.
    pub exif: Option<Vec<u8>>,
    pub dpi: Option<(f32, f32)>,
}

impl Decoded {
    pub fn single(img: RgbaImage, format: SourceFormat) -> Self {
        Decoded {
            frames: vec![img],
            delays_ms: vec![0],
            plays: 0,
            format,
            icc: None,
            exif: None,
            dpi: None,
        }
    }

    pub fn bytes(&self) -> usize {
        self.frames.iter().map(|f| f.as_raw().len()).sum()
    }

    /// Como a animação toca: atrasos vazios quando não há animação (estática, TIFF de páginas).
    pub fn playback(&self) -> Playback {
        let animated =
            self.frames.len() > 1 && matches!(self.format, SourceFormat::Gif | SourceFormat::Webp);
        if !animated {
            return Playback::default();
        }
        Playback {
            // Regra dos navegadores: atraso de até 10 ms vira 100 ms.
            delays_ms: self
                .delays_ms
                .iter()
                .map(|&ms| if ms <= 10 { 100 } else { ms })
                .collect(),
            plays: self.plays,
        }
    }
}

/// Atraso de cada quadro (ms, já normalizado) e total de vezes que toca (0 = para sempre).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Playback {
    pub delays_ms: Vec<u32>,
    pub plays: u32,
}

/// Teto de memória de uma imagem decodificada (RGBA8, todas as páginas somadas).
/// Arquivos que declaram mais que isso falham com erro antes de alocar.
pub const MAX_DECODE_BYTES: usize = 2 << 30;

/// Recusa dimensões cujo RGBA8 (somado a `already` bytes de páginas anteriores) passe do teto.
pub(super) fn check_budget(w: u32, h: u32, already: usize) -> AppResult<usize> {
    check_budget_max(w, h, already, MAX_DECODE_BYTES)
}

/// Como `check_budget`, com teto explícito (os testes usam um teto pequeno).
fn check_budget_max(w: u32, h: u32, already: usize, max: usize) -> AppResult<usize> {
    let bytes = (w as usize)
        .checked_mul(h as usize)
        .and_then(|p| p.checked_mul(4))
        .and_then(|b| b.checked_add(already))
        .filter(|&b| b <= max);
    bytes.ok_or_else(|| {
        AppError::Unsupported(format!(
            "imagem grande demais ({w}x{h}); o limite é {} MiB",
            max >> 20
        ))
    })
}

/// Memória que decodificar `bytes` deve ocupar, lida só do cabeçalho (RGBA8 = 4 bytes/pixel).
/// RAW: o IFD0 costuma ser a miniatura, então usa o maior IFD/SubIFD (o sensor) x 12
/// (dados do sensor + revelação + RGBA), ou 8x o arquivo, o que for maior.
/// Limitada a `MAX_DECODE_BYTES`: acima disso a decodificação falha antes de alocar.
pub fn estimate_bytes(path: &Path, bytes: &[u8]) -> usize {
    let by_file = bytes.len().saturating_mul(8);
    let format = detect_format(path, bytes);
    // Memória de trabalho por pixel, a mesma que cada decodificador confere.
    let per_pixel = match format {
        // Luz linear: os pixels passam por f32 antes do RGBA8.
        Some(SourceFormat::Exr | SourceFormat::Hdr) => 20,
        Some(SourceFormat::Jxl) => jxl::WORK_BYTES_PER_PIXEL,
        // PQ/HLG: RGBA16 de trabalho (e, no HEIF, o plano de 16 bits) antes do RGBA8.
        Some(SourceFormat::Png) if matches!(cicp::png_color(bytes), Some(cicp::Color::Hdr(..))) => 12,
        Some(SourceFormat::Heic | SourceFormat::Avif) if cicp::isobmff_is_hdr(bytes) => 20,
        // 16 bits por canal (Farbfeld sempre): o RGBA16 vivo junto do RGBA8.
        Some(SourceFormat::Farbfeld) => 12,
        Some(SourceFormat::Pnm) if pnm_maxval(bytes).is_some_and(|m| m > 255) => 12,
        _ => 4,
    };
    let est = if format == Some(SourceFormat::Raw) {
        raw_sensor_pixels(bytes).map_or(by_file, |px| px.saturating_mul(12).max(by_file))
    } else {
        imagesize::blob_size(bytes)
            .map(|s| s.width.saturating_mul(s.height).saturating_mul(per_pixel))
            .unwrap_or(by_file)
    };
    est.min(MAX_DECODE_BYTES)
}

/// `maxval` do cabeçalho PNM (P2/P3/P5/P6, ou `MAXVAL` do PAM); bitmaps (P1/P4) valem 1.
fn pnm_maxval(bytes: &[u8]) -> Option<u32> {
    let head = &bytes[..bytes.len().min(1024)];
    let mut words = head
        .split(|&b| b == b'\n' || b == b'\r')
        .flat_map(|line| {
            let line = line.split(|&b| b == b'#').next().unwrap_or_default();
            line.split(|b| b.is_ascii_whitespace()).filter(|w| !w.is_empty())
        });
    let num = |w: &[u8]| std::str::from_utf8(w).ok()?.parse::<u32>().ok();
    match words.next()? {
        b"P1" | b"P4" => Some(1),
        b"P2" | b"P3" | b"P5" | b"P6" => words.nth(2).and_then(num),
        b"P7" => {
            let mut words = words.skip_while(|w| *w != b"MAXVAL");
            words.next()?;
            words.next().and_then(num)
        }
        _ => None,
    }
}

/// Maior largura x altura entre os IFDs de um RAW baseado em TIFF (DNG, NEF, ARW, CR2...),
/// sem decodificar pixels. `None` para os que não são TIFF (CR3, RAF, CRW).
fn raw_sensor_pixels(bytes: &[u8]) -> Option<usize> {
    use rawler::{
        formats::tiff::{GenericTiffReader, reader::TiffReader},
        tags::TiffCommonTag as Tag,
    };
    guarded(|| {
        const SUB_IFDS: u16 = 330;
        let mut cur = Cursor::new(bytes);
        let tiff = GenericTiffReader::new(&mut cur, 0, 0, Some(16), &[SUB_IFDS])
            .map_err(AppError::corrupt)?;
        tiff.chains()
            .iter()
            .flat_map(|ifd| ifd.find_ifds_with_tag(Tag::ImageWidth))
            .filter_map(|ifd| {
                let w = ifd.get_entry(Tag::ImageWidth)?.value.force_usize(0);
                let h = ifd.get_entry(Tag::ImageLength)?.value.force_usize(0);
                Some(w.saturating_mul(h))
            })
            .max()
            .ok_or_else(short)
    })
    .ok()
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
        "jp2" | "jpx" | "jpf" => Jp2,
        "j2k" | "j2c" | "jpc" => J2c,
        "jxl" => Jxl,
        "exr" => Exr,
        "hdr" | "pic" => Hdr,
        "pnm" | "pbm" | "pgm" | "ppm" | "pam" => Pnm,
        "icns" => Icns,
        "dds" => Dds,
        "ff" => Farbfeld,
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
    } else if starts(b"\0\0\0\x0cjP  \r\n\x87\n") {
        Some(Jp2)
    } else if starts(&J2K_CODESTREAM) {
        Some(J2c)
    } else if starts(&[0xFF, 0x0A]) || starts(b"\0\0\0\x0cJXL \r\n\x87\n") {
        Some(Jxl)
    } else if starts(&[0x76, 0x2F, 0x31, 0x01]) {
        Some(Exr)
    } else if starts(b"#?RADIANCE") || starts(b"#?RGBE") {
        Some(Hdr)
    } else if starts(b"icns") {
        Some(Icns)
    } else if starts(b"DDS ") {
        Some(Dds)
    } else if starts(b"farbfeld") {
        Some(Farbfeld)
    } else if let [b'P', b'1'..=b'7', sep, ..] = head
        && (sep.is_ascii_whitespace() || *sep == b'#')
    {
        Some(Pnm)
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

/// SOC e SIZ de um codestream JPEG 2000 sem contêiner.
const J2K_CODESTREAM: [u8; 4] = [0xFF, 0x4F, 0xFF, 0x51];

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
    guarded(|| decode_format(bytes, format))
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

fn decode_format(bytes: &[u8], format: SourceFormat) -> AppResult<Decoded> {
    use SourceFormat::*;
    let mut d = match format {
        Jpeg => decode_image_crate(bytes, ImageFormat::Jpeg, format),
        Png => decode_png(bytes),
        Pnm => decode_image_crate(bytes, ImageFormat::Pnm, format),
        Dds => decode_image_crate(bytes, ImageFormat::Dds, format),
        Farbfeld => decode_image_crate(bytes, ImageFormat::Farbfeld, format),
        Exr => hdr::decode_exr(bytes),
        Hdr => hdr::decode_radiance(bytes),
        Icns => icns::decode(bytes),
        Jxl => jxl::decode(bytes),
        Bmp => decode_image_crate(bytes, ImageFormat::Bmp, format),
        Ico => decode_image_crate(bytes, ImageFormat::Ico, format),
        Tga => decode_image_crate(bytes, ImageFormat::Tga, format),
        Gif => decode_gif(bytes),
        Webp => decode_webp(bytes),
        Tiff => {
            decode_tiff(bytes).or_else(|_| decode_image_crate(bytes, ImageFormat::Tiff, format))
        }
        Heic | Avif => decode_heif(bytes, format),
        Svg => decode_svg(bytes),
        Psd => decode_psd(bytes),
        Raw => decode_raw(bytes),
        Jp2 | J2c => decode_jp2(bytes, format),
    }?;
    if d.dpi.is_none() {
        d.dpi = match format {
            Jpeg => jfif_dpi(bytes),
            Png => png_dpi(bytes),
            _ => None,
        };
    }
    match format {
        // O EXIF do TIFF está no próprio IFD0 (e nos sub-IFDs EXIF/GPS).
        Tiff if d.exif.is_none() => d.exif = super::container::tiff_exif_block(bytes),
        Bmp if d.icc.is_none() => d.icc = super::container::bmp_icc(bytes),
        _ => {}
    }
    Ok(d)
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_alloc = Some(MAX_DECODE_BYTES as u64);
    l
}

fn decode_image_crate(bytes: &[u8], fmt: ImageFormat, format: SourceFormat) -> AppResult<Decoded> {
    let (img, icc, exif) = read_image(bytes, fmt)?;
    Ok(Decoded {
        icc,
        exif,
        ..Decoded::single(into_rgba(img), format)
    })
}

/// PNG com a cor que o arquivo declara (ver `cicp::png_color`).
fn decode_png(bytes: &[u8]) -> AppResult<Decoded> {
    let (img, embedded, exif) = read_image(bytes, ImageFormat::Png)?;
    let color = cicp::png_color(bytes);
    let rgba = match &color {
        Some(cicp::Color::Hdr(transfer, _)) => {
            // RGBA16 de trabalho mais o RGBA8 final.
            hdr::check_pixels(img.width() as usize, img.height() as usize, 12)?;
            sdr8(img.into_rgba16(), *transfer)
        }
        _ => into_rgba(img),
    };
    Ok(Decoded {
        icc: color.map_or(embedded, cicp::Color::icc),
        exif,
        ..Decoded::single(rgba, SourceFormat::Png)
    })
}

fn sdr8(mut img: Rgba16Image, transfer: hdr::Transfer) -> RgbaImage {
    hdr::to_sdr(&mut img, transfer);
    DynamicImage::ImageRgba16(img).into_rgba8()
}

/// Imagem orientada, perfil ICC e EXIF.
type Raw = (DynamicImage, Option<Vec<u8>>, Option<Vec<u8>>);

fn read_image(bytes: &[u8], fmt: ImageFormat) -> AppResult<Raw> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), fmt);
    reader.limits(limits());
    let mut dec = reader.into_decoder()?;
    let orientation = dec.orientation().unwrap_or(Orientation::NoTransforms);
    let icc = dec.icc_profile().ok().flatten();
    let exif = dec.exif_metadata().ok().flatten();
    let (w, h) = dec.dimensions();
    // O buffer decodificado (16 bits, cinza...) fica vivo junto do RGBA8 final; RGBA8 é o próprio, e
    // RGB8 é expandido no lugar (`into_rgba`).
    let decoded = match dec.color_type() {
        image::ColorType::Rgba8 | image::ColorType::Rgb8 => 0,
        _ => usize::try_from(dec.total_bytes()).unwrap_or(usize::MAX),
    };
    check_budget(w, h, decoded)?;
    let mut img = DynamicImage::from_decoder(dec)?;
    img.apply_orientation(orientation);
    Ok((img, icc, exif))
}

/// Como `into_rgba8`, mas RGB8 é expandido no mesmo buffer: sem RGB e RGBA vivos juntos.
fn into_rgba(img: DynamicImage) -> RgbaImage {
    let DynamicImage::ImageRgb8(rgb) = img else {
        return img.into_rgba8();
    };
    let (w, h) = rgb.dimensions();
    let mut v = rgb.into_raw();
    let n = v.len() / 3;
    // Realocações grandes do glibc usam mremap: crescer o Vec não copia nem duplica.
    v.resize(n * 4, 255);
    for i in (0..n).rev() {
        let (r, g, b) = (v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
        v[i * 4..i * 4 + 4].copy_from_slice(&[r, g, b, 255]);
    }
    RgbaImage::from_raw(w, h, v).expect("tamanho calculado acima")
}

/// Quadros de uma animação, somando cada um contra o teto antes de guardar o próximo.
fn frames_of<'a>(
    dec: impl AnimationDecoder<'a>,
    format: SourceFormat,
    max: usize,
) -> AppResult<Decoded> {
    let plays = match dec.loop_count() {
        LoopCount::Infinite => 0,
        // GIF declara as repetições depois da primeira volta (NETSCAPE2.0: n => n + 1 vezes,
        // como nos navegadores); o WebP declara o total.
        LoopCount::Finite(n) if format == SourceFormat::Gif => n.get().saturating_add(1),
        LoopCount::Finite(n) => n.get(),
    };
    let frames = dec.into_frames();
    let (mut images, mut delays_ms, mut total) = (Vec::new(), Vec::new(), 0);
    for f in frames {
        let f = f?;
        let (w, h) = f.buffer().dimensions();
        total = check_budget_max(w, h, total, max)?;
        let (n, d) = f.delay().numer_denom_ms();
        delays_ms.push(n.checked_div(d).unwrap_or(0));
        images.push(f.into_buffer());
    }
    if images.is_empty() {
        return Err(AppError::Corrupt("animação sem quadros".into()));
    }
    Ok(Decoded {
        frames: images,
        delays_ms,
        plays,
        format,
        icc: None,
        exif: None,
        dpi: None,
    })
}

fn decode_gif(bytes: &[u8]) -> AppResult<Decoded> {
    decode_gif_max(bytes, MAX_DECODE_BYTES)
}

fn decode_gif_max(bytes: &[u8], max: usize) -> AppResult<Decoded> {
    let dec = ::image::codecs::gif::GifDecoder::new(Cursor::new(bytes))?;
    frames_of(dec, SourceFormat::Gif, max)
}

fn decode_webp(bytes: &[u8]) -> AppResult<Decoded> {
    let dec = ::image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))?;
    if dec.has_animation() {
        frames_of(dec, SourceFormat::Webp, MAX_DECODE_BYTES)
    } else {
        decode_image_crate(bytes, ImageFormat::WebP, SourceFormat::Webp)
    }
}

/// TIFF com todas as páginas (a crate `image` só lê a primeira).
fn decode_tiff(bytes: &[u8]) -> AppResult<Decoded> {
    decode_tiff_max(bytes, MAX_DECODE_BYTES)
}

fn decode_tiff_max(bytes: &[u8], max: usize) -> AppResult<Decoded> {
    use tiff::{
        ColorType as C,
        decoder::{Decoder, DecodingResult as R, Limits as TL},
        tags::Tag,
    };
    let map = |e: tiff::TiffError| AppError::corrupt(e);
    let mut dec = Decoder::new(Cursor::new(bytes)).map_err(map)?.with_limits({
        // `unlimited()` + tetos: o padrão (256 MiB) recusaria TIFFs grandes legítimos.
        let mut l = TL::unlimited();
        l.decoding_buffer_size = MAX_DECODE_BYTES * 2; // 16 bits/canal antes de reduzir
        l.intermediate_buffer_size = MAX_DECODE_BYTES;
        l.ifd_value_size = 64 << 20;
        l
    });
    let mut frames = Vec::new();
    let mut icc = None;
    let mut dpi = None;
    let mut total = 0;
    loop {
        let (w, h) = dec.dimensions().map_err(map)?;
        // Antes de `read_image`: o cabeçalho pode declarar dimensões absurdas.
        total = check_budget_max(w, h, total, max)?;
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
        frames.push(into_rgba(img));
        if !dec.more_images() {
            break;
        }
        dec.next_image().map_err(map)?;
    }
    let n = frames.len();
    Ok(Decoded {
        frames,
        delays_ms: vec![0; n],
        plays: 0,
        format: SourceFormat::Tiff,
        icc,
        exif: None,
        dpi,
    })
}

pub(super) fn short() -> AppError {
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
    // ResolutionUnit: 1 = sem unidade (só a proporção), 2 = polegada (padrão), 3 = centímetro.
    let k = match dec.find_tag_unsigned::<u16>(Tag::ResolutionUnit).ok().flatten() {
        Some(1) => return None,
        Some(3) => 2.54,
        _ => 1.0,
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
    let hevc = super::heic::hevc_available();
    let lib = LibHeif::new();
    let ctx = HeifContext::read_from_bytes(bytes).map_err(map)?;
    let handle = ctx.primary_image_handle().map_err(map)?;
    check_budget(handle.width(), handle.height(), 0)?;
    // O ICC embutido vence o nclx. Valores que a libheif-rs não conhece viram reservados.
    let embedded = handle.color_profile_raw().map(|p| p.data);
    let color = match embedded {
        Some(_) => None,
        None => handle.color_profile_nclx().and_then(|c| {
            cicp::from_code_points(c.color_primaries() as u8, c.transfer_characteristics() as u8)
        }),
    };
    // PQ e HLG têm 10 bits ou mais: em 8 as sombras ficariam em degraus.
    let transfer = match &color {
        Some(cicp::Color::Hdr(t, _)) => Some(*t),
        _ => None,
    };
    if transfer.is_some() {
        // Plano de 16 bits, RGBA16 de trabalho e o RGBA8 final.
        hdr::check_pixels(handle.width() as usize, handle.height() as usize, 20)?;
    }
    let chroma = match transfer {
        Some(_) => RgbChroma::HdrRgbaLe,
        None => RgbChroma::Rgba,
    };
    // O libheif já aplica as transformações do contêiner (irot/imir): não há EXIF a aplicar.
    let img = lib
        .decode(&handle, ColorSpace::Rgb(chroma), None)
        .map_err(|e| match map(e) {
            // Sem libde265 a libheif não tem decodificador HEVC: mensagem própria na interface.
            AppError::Unsupported(m) if format == SourceFormat::Heic && !hevc => {
                AppError::HeicDecoderMissing(m)
            }
            other => other,
        })?;
    let (w, h) = (img.width(), img.height());
    check_budget(w, h, 0)?;
    let planes = img.planes();
    let plane = planes.interleaved.ok_or_else(short)?;
    let bytes_px = if transfer.is_some() { 8 } else { 4 };
    let row = |y: usize| {
        let start = y * plane.stride;
        plane.data.get(start..start + w as usize * bytes_px).ok_or_else(short)
    };
    let rgba = match transfer {
        None => {
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for y in 0..h as usize {
                out.extend_from_slice(row(y)?);
            }
            RgbaImage::from_raw(w, h, out)
        }
        Some(t) => {
            let max = (1u32 << plane.bits_per_pixel.clamp(1, 16)) - 1;
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for y in 0..h as usize {
                out.extend(row(y)?.as_chunks::<2>().0.iter().map(|b| {
                    let v = u32::from(u16::from_le_bytes(*b)).min(max);
                    ((v * 65_535 + max / 2) / max) as u16
                }));
            }
            Rgba16Image::from_raw(w, h, out).map(|i| sdr8(i, t))
        }
    };
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
        icc: embedded.or(color.and_then(cicp::Color::icc)),
        exif,
        ..Decoded::single(rgba.ok_or_else(short)?, format)
    })
}

/// Memória de trabalho do OpenJPEG: planos `i32` por componente (até 16 B/pixel em RGBA),
/// mais o RGBA8 final. 4/5 do teto para o decodificador deixa o pico perto de `MAX_DECODE_BYTES`.
const JP2_DECODER_BYTES: u64 = MAX_DECODE_BYTES as u64 / 5 * 4;

fn decode_jp2(bytes: &[u8], format: SourceFormat) -> AppResult<Decoded> {
    use openjp2::{
        DecodeLimits, DecodeParameters, Decoder, Error as E, Image, J2KFormat, Stream,
    };
    let map = |e: E| match e {
        E::Unsupported(m) => AppError::Unsupported(m),
        other => AppError::Corrupt(other.to_string()),
    };
    // Recusa pelo cabeçalho, antes de alocar os planos.
    let kind = match format {
        SourceFormat::J2c => J2KFormat::J2K,
        _ => J2KFormat::JP2,
    };
    let header = Decoder::new(kind)
        .and_then(|mut d| d.read_header(&mut Stream::from_bytes(bytes.to_vec())))
        .map_err(map)?;
    check_budget(header.width(), header.height(), 0)?;
    let params =
        DecodeParameters::new().limits(DecodeLimits::new().max_mem_alloc(JP2_DECODER_BYTES));
    let img = Image::from_bytes_with(bytes, params).map_err(map)?;
    let rgba = DynamicImage::try_from(&img).map_err(map)?.into_rgba8();
    let icc = Some(img.into_core_image().icc_profile_buf).filter(|p| !p.is_empty());
    Ok(Decoded {
        icc,
        ..Decoded::single(rgba, format)
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

fn decode_svg(bytes: &[u8]) -> AppResult<Decoded> {
    use resvg::{tiny_skia, usvg};
    // Um SVG não pode ler arquivos locais (`<image href="/home/...">`): só `data:` URLs.
    let mut opt = usvg::Options {
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
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
    // Cabeçalho: "8BPS", versão (2), reservado (6), canais (2), altura (4), largura (4).
    let be = |r: std::ops::Range<usize>| {
        bytes
            .get(r)
            .map(|b| u32::from_be_bytes(b.try_into().expect("4 bytes")))
    };
    let (h, w) = be(14..18).zip(be(18..22)).ok_or_else(short)?;
    check_budget(w, h, 0)?;
    let psd = psd::Psd::from_bytes(bytes).map_err(AppError::corrupt)?;
    let img = RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or_else(short)?;
    Ok(Decoded::single(img, SourceFormat::Psd))
}

/// Prévia JPEG embutida no RAW (já orientada), para abrir rápido enquanto revela.
pub fn raw_preview(bytes: &[u8]) -> Option<RgbaImage> {
    guarded(|| {
        use rawler::{decoders::RawDecodeParams, rawsource::RawSource};
        let src = RawSource::new_from_slice(bytes);
        let dec = rawler::get_decoder(&src).map_err(|e| AppError::Unsupported(e.to_string()))?;
        let params = RawDecodeParams::default();
        let img = dec
            .preview_image(&src, &params)
            .ok()
            .flatten()
            .ok_or_else(short)?;
        check_budget(img.width(), img.height(), 0)?;
        let mut img = DynamicImage::ImageRgba8(into_rgba(img));
        if let Ok(meta) = dec.raw_metadata(&src, &params)
            && let Some(o) = meta
                .exif
                .orientation
                .and_then(|o| Orientation::from_exif(o as u8))
        {
            img.apply_orientation(o);
        }
        Ok(img.into_rgba8())
    })
    .ok()
}

/// RAW com a revelação padrão do `rawler` (demosaico, balanço de branco, sRGB).
fn decode_raw(bytes: &[u8]) -> AppResult<Decoded> {
    use rawler::{imgop::develop::RawDevelop, rawsource::RawSource};
    let src = RawSource::new_from_slice(bytes);
    let raw = rawler::decode(&src, &Default::default())
        .map_err(|e| AppError::Unsupported(e.to_string()))?;
    check_budget(raw.width as u32, raw.height as u32, 0)?;
    let orientation = Orientation::from_exif(raw.orientation.to_u16() as u8);
    let mut img = RawDevelop::default()
        .develop_intermediate(&raw)
        .map_err(AppError::corrupt)?
        .to_dynamic_image()
        .ok_or_else(short)?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Ok(Decoded::single(into_rgba(img), SourceFormat::Raw))
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
        .filter_map(|e| {
            let p = e.path();
            // Arquivo comum já basta; link só se apontar para um arquivo.
            let file = e
                .file_type()
                .is_ok_and(|t| t.is_file() || (t.is_symlink() && p.is_file()));
            (file && is_supported_path(&p))
                .then(|| (e.file_name().to_string_lossy().into_owned(), p.to_string_lossy().into_owned()))
        })
        .collect();
    files.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    Ok(files.into_iter().map(|(_, p)| p).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiff_pages(n: usize, w: u32, h: u32) -> Vec<u8> {
        use tiff::encoder::{TiffEncoder, colortype::Gray8};
        let mut out = Cursor::new(Vec::new());
        let mut enc = TiffEncoder::new(&mut out).unwrap();
        for _ in 0..n {
            enc.write_image::<Gray8>(w, h, &vec![128; (w * h) as usize])
                .unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn tiff_multipagina_estoura_so_na_soma() {
        let bytes = tiff_pages(3, 100, 100); // 40 KB de RGBA por página
        let r = decode_tiff_max(&bytes, 100_000);
        assert!(matches!(r, Err(AppError::Unsupported(_))), "{:?}", r.err());
        let ok = decode_tiff_max(&bytes, 130_000).unwrap();
        assert_eq!(ok.frames.len(), 3);
    }

    #[test]
    fn tiff_com_cabecalho_gigante_e_unsupported() {
        let mut b = tiff_pages(1, 4, 4);
        // ImageWidth/ImageLength (tags 256/257) do único IFD passam a 100000x100000.
        let ifd = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
        let n = u16::from_le_bytes(b[ifd..ifd + 2].try_into().unwrap()) as usize;
        for e in 0..n {
            let at = ifd + 2 + e * 12;
            let tag = u16::from_le_bytes(b[at..at + 2].try_into().unwrap());
            if tag == 256 || tag == 257 {
                b[at + 2..at + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
                b[at + 8..at + 12].copy_from_slice(&100_000u32.to_le_bytes());
            }
        }
        let r = decode_tiff(&b);
        assert!(matches!(r, Err(AppError::Unsupported(_))), "{:?}", r.err());
    }

    #[test]
    fn estimativa_de_raw_forjado_fica_no_teto() {
        // TIFF/DNG com ImageWidth = ImageLength = u32::MAX: sensor x 12 satura em usize::MAX.
        let mut b = b"II*\0\x08\0\0\0".to_vec();
        b.extend_from_slice(&2u16.to_le_bytes());
        for tag in [256u16, 257] {
            b.extend_from_slice(&tag.to_le_bytes());
            b.extend_from_slice(&4u16.to_le_bytes()); // LONG
            b.extend_from_slice(&1u32.to_le_bytes());
            b.extend_from_slice(&u32::MAX.to_le_bytes());
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(
            detect_format(Path::new("forjado.dng"), &b),
            Some(SourceFormat::Raw)
        );
        assert_eq!(
            estimate_bytes(Path::new("forjado.dng"), &b),
            MAX_DECODE_BYTES
        );
    }

    #[test]
    fn psd_com_cabecalho_gigante_e_unsupported() {
        let mut b = b"8BPS\0\x01\0\0\0\0\0\0\0\x03".to_vec();
        b.extend_from_slice(&30_000u32.to_be_bytes());
        b.extend_from_slice(&30_000u32.to_be_bytes());
        b.extend_from_slice(&[0, 8, 0, 3]);
        b.extend_from_slice(&[0; 16]);
        let r = decode_psd(&b);
        assert!(matches!(r, Err(AppError::Unsupported(_))), "{:?}", r.err());
    }

    #[test]
    fn gif_animado_soma_os_quadros_contra_o_teto() {
        use ::image::{Delay, Frame, codecs::gif::GifEncoder};
        let mut buf = Vec::new();
        {
            let mut enc = GifEncoder::new(&mut buf);
            let frames = (0..5u8).map(|i| {
                let img = RgbaImage::from_pixel(50, 50, ::image::Rgba([i * 40, 0, 0, 255]));
                Frame::from_parts(img, 0, 0, Delay::from_numer_denom_ms(100, 1))
            });
            enc.encode_frames(frames).unwrap();
        }
        // 5 quadros de 10 KB: com teto de 30 KB o quarto já estoura.
        let r = decode_gif_max(&buf, 30_000);
        assert!(matches!(r, Err(AppError::Unsupported(_))), "{:?}", r.err());
        assert_eq!(
            decode_gif_max(&buf, 60_000).unwrap().frames.len(),
            5
        );
    }

    /// GIF com atrasos diferentes por quadro e repetição finita declarada (NETSCAPE2.0).
    fn gif_com_atrasos(delays_ms: &[u32], repeat: Option<u16>) -> Vec<u8> {
        use ::image::{
            Delay, Frame,
            codecs::gif::{GifEncoder, Repeat},
        };
        let mut buf = Vec::new();
        {
            let mut enc = GifEncoder::new(&mut buf);
            if let Some(n) = repeat {
                enc.set_repeat(Repeat::Finite(n)).unwrap();
            }
            let frames = delays_ms.iter().enumerate().map(|(i, &ms)| {
                let img = RgbaImage::from_pixel(4, 4, ::image::Rgba([i as u8 * 60, 0, 0, 255]));
                Frame::from_parts(img, 0, 0, Delay::from_numer_denom_ms(ms, 1))
            });
            enc.encode_frames(frames).unwrap();
        }
        buf
    }

    #[test]
    fn gif_respeita_atraso_de_cada_quadro_e_regra_dos_navegadores() {
        // 0 e 10 ms viram 100 ms (como nos navegadores); 20, 70 e 500 ms ficam.
        let d = decode_gif(&gif_com_atrasos(&[0, 10, 20, 70, 500], Some(2))).unwrap();
        assert_eq!(d.delays_ms, vec![0, 10, 20, 70, 500]);
        let p = d.playback();
        assert_eq!(p.delays_ms, vec![100, 100, 20, 70, 500]);
        // NETSCAPE com 2 repetições: toca 3 vezes no total, como nos navegadores.
        assert_eq!(p.plays, 3);
    }

    #[test]
    fn gif_sem_contagem_toca_para_sempre_e_estatica_nao_anima() {
        let d = decode_gif(&gif_com_atrasos(&[30, 40], None)).unwrap();
        assert_eq!(d.playback().plays, 0);
        assert_eq!(d.playback().delays_ms, vec![30, 40]);
        let um = decode_gif(&gif_com_atrasos(&[30], Some(1))).unwrap();
        assert!(um.playback().delays_ms.is_empty(), "um quadro não anima");
    }
}
