//! JPEG XL pelo `jxl-oxide` (Rust puro, MIT/Apache; já vinha com o `rawler`, que o usa nos DNG).
//! Só o primeiro quadro de uma animação. PQ e HLG saem em sRGB, pelo mapeamento da própria crate.
//! Caixas `brob` (metadados comprimidos com Brotli) são descartadas antes: expandem sem teto.
use super::{
    cicp,
    decode::{Decoded, MAX_DECODE_BYTES, short},
    hdr, icc,
};
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::RgbaImage;
use jxl_oxide::{AllocTracker, EnumColourEncoding, JxlImage, RenderingIntent};
use std::borrow::Cow;

/// Bytes por pixel do pior caso: planos f32 de até quatro canais mais o RGBA8 final.
pub(super) const WORK_BYTES_PER_PIXEL: usize = 20;

const CONTAINER: &[u8] = b"\0\0\0\x0cJXL \r\n\x87\n";

/// Os bytes sem as caixas `brob` do contêiner ISOBMFF (o codestream solto passa direto).
fn without_brob(bytes: &[u8]) -> AppResult<Cow<'_, [u8]>> {
    if !bytes.starts_with(CONTAINER) {
        return Ok(Cow::Borrowed(bytes));
    }
    let (mut out, mut pos, mut dropped) = (Vec::with_capacity(bytes.len()), 0usize, false);
    while pos < bytes.len() {
        let rest = &bytes[pos..];
        let head = rest.get(..8).ok_or_else(short)?;
        let (size, header) = match u32::from_be_bytes([head[0], head[1], head[2], head[3]]) {
            0 => (rest.len() as u64, 8),
            1 => {
                let large = rest.get(8..16).ok_or_else(short)?;
                (u64::from_be_bytes(large.try_into().map_err(|_| short())?), 16)
            }
            n => (u64::from(n), 8),
        };
        if size < header {
            return Err(short());
        }
        // Caixa cortada no fim do arquivo: vai como está (o decodificador decide).
        let len = usize::try_from(size).unwrap_or(usize::MAX).min(rest.len());
        if &head[4..8] == b"brob" {
            dropped = true;
        } else {
            out.extend_from_slice(&rest[..len]);
        }
        pos += len;
    }
    Ok(if dropped { Cow::Owned(out) } else { Cow::Borrowed(bytes) })
}

pub fn decode(bytes: &[u8]) -> AppResult<Decoded> {
    let bytes = without_brob(bytes)?;
    // As dimensões declaradas valem antes de o decodificador ler os quadros.
    if let Ok(s) = imagesize::blob_size(&bytes) {
        hdr::check_pixels(s.width, s.height, WORK_BYTES_PER_PIXEL)?;
    }
    let tracker = AllocTracker::with_limit(MAX_DECODE_BYTES);
    let mut img = JxlImage::builder()
        .alloc_tracker(tracker.clone())
        .read(&*bytes)
        .map_err(AppError::corrupt)?;
    let (w, h) = (img.width(), img.height());
    hdr::check_pixels(w as usize, h as usize, WORK_BYTES_PER_PIXEL)?;
    // O RGBA8 final sai do mesmo orçamento que o decodificador usa.
    let out_len = w as usize * h as usize * 4;
    tracker.shrink_limit(out_len).map_err(AppError::corrupt)?;
    let format = img.pixel_format();
    if format.has_black() {
        return Err(AppError::Unsupported("JPEG XL em CMYK".into()));
    }
    // Cinza sem perfil próprio também vai para a curva do sRGB: o documento trata cinza como RGB.
    if img.hdr_type().is_some() || (format.is_grayscale() && img.original_icc().is_none()) {
        let encoding = if format.is_grayscale() {
            EnumColourEncoding::gray_srgb
        } else {
            EnumColourEncoding::srgb
        };
        img.request_color_encoding(encoding(RenderingIntent::Relative));
    }
    let mut rgba = vec![0u8; out_len];
    let n = {
        let render = img.render_frame(0).map_err(AppError::corrupt)?;
        let mut stream = render.stream();
        let n = stream.channels() as usize;
        if (stream.width(), stream.height()) != (w, h) || !(1..=4).contains(&n) {
            return Err(short());
        }
        let len = out_len / 4 * n;
        if stream.write_to_buffer(&mut rgba[..len]) != len {
            return Err(short());
        }
        n
    };
    // Expande para RGBA no próprio buffer, de trás para frente (o destino nunca passa a origem).
    if n < 4 {
        for i in (0..out_len / 4).rev() {
            let s = i * n;
            let px = match n {
                1 => [rgba[s], rgba[s], rgba[s], 255],
                2 => [rgba[s], rgba[s], rgba[s], rgba[s + 1]],
                _ => [rgba[s], rgba[s + 1], rgba[s + 2], 255],
            };
            rgba[i * 4..i * 4 + 4].copy_from_slice(&px);
        }
    }
    let associated = img
        .image_header()
        .metadata
        .ec_info
        .iter()
        .find_map(|e| e.alpha_associated())
        .unwrap_or(false);
    if associated && n % 2 == 0 {
        for p in rgba.as_chunks_mut::<4>().0 {
            let a = u16::from(p[3]).max(1);
            for c in &mut p[..3] {
                *c = ((u16::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    let profile = match img.rendered_cicp().and_then(|c| cicp::from_code_points(c[0], c[1])) {
        Some(color) => color.icc(),
        None => Some(img.rendered_icc()).filter(|p| icc::is_rgb_profile(p)),
    };
    let exif = img
        .aux_boxes()
        .first_exif()
        .ok()
        .filter(|b| b.has_data())
        .and_then(|b| {
            let exif = b.unwrap();
            exif.payload().get(exif.tiff_header_offset() as usize..).map(<[u8]>::to_vec)
        });
    Ok(Decoded {
        icc: profile,
        exif,
        ..Decoded::single(RgbaImage::from_raw(w, h, rgba).ok_or_else(short)?, SourceFormat::Jxl)
    })
}
