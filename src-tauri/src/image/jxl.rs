//! JPEG XL pelo `jxl-oxide` (Rust puro, MIT/Apache; já vinha com o `rawler`, que o usa nos DNG).
//! Só o primeiro quadro de uma animação. PQ e HLG saem em sRGB, pelo mapeamento da própria crate.
use super::{
    cicp,
    decode::{Decoded, MAX_DECODE_BYTES, check_budget, short},
    icc,
};
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::RgbaImage;
use jxl_oxide::{AllocTracker, EnumColourEncoding, JxlImage, RenderingIntent};

pub fn decode(bytes: &[u8]) -> AppResult<Decoded> {
    let mut img = JxlImage::builder()
        .alloc_tracker(AllocTracker::with_limit(MAX_DECODE_BYTES))
        .read(bytes)
        .map_err(AppError::corrupt)?;
    check_budget(img.width(), img.height(), 0)?;
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
    let render = img.render_frame(0).map_err(AppError::corrupt)?;
    let mut stream = render.stream();
    let (w, h, n) = (stream.width(), stream.height(), stream.channels() as usize);
    check_budget(w, h, 0)?;
    if !(1..=4).contains(&n) {
        return Err(short());
    }
    let mut px = vec![0u8; w as usize * h as usize * n];
    if stream.write_to_buffer(&mut px) != px.len() {
        return Err(short());
    }
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for p in px.chunks_exact(n) {
        rgba.extend(match *p {
            [l] => [l, l, l, 255],
            [l, a] => [l, l, l, a],
            [r, g, b] => [r, g, b, 255],
            _ => [p[0], p[1], p[2], p[3]],
        });
    }
    drop(px);
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
