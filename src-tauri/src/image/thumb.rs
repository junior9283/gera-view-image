//! Prévias e miniaturas no formato do IPC: `u32 LE w`, `u32 LE h`, RGBA.
use crate::doc::model::Rect;
use ::image::RgbaImage;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer, images::Image};

/// Maior tamanho que cabe em `max_w`x`max_h` mantendo a proporção, sem ampliar (mínimo 1x1).
pub fn fit_size(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let k = (max_w.max(1) as f64 / w as f64)
        .min(max_h.max(1) as f64 / h as f64)
        .min(1.0);
    (
        ((w as f64 * k).round() as u32).max(1),
        ((h as f64 * k).round() as u32).max(1),
    )
}

/// Redimensiona o trecho `src` de `img` direto em `out` (RGBA, `w*h*4` bytes).
pub fn resize_into(img: &RgbaImage, src: Rect, w: u32, h: u32, alg: ResizeAlg, out: &mut [u8]) {
    let row = w as usize * 4;
    if (src.w, src.h) == (w, h) {
        // Sem escala: copia as linhas do recorte.
        let stride = img.width() as usize * 4;
        for (y, dst) in out.chunks_exact_mut(row).enumerate() {
            let start = (src.y as usize + y) * stride + src.x as usize * 4;
            dst.copy_from_slice(&img.as_raw()[start..start + row]);
        }
        return;
    }
    let mut dst =
        Image::from_slice_u8(w, h, out, PixelType::U8x4).expect("buffer com o tamanho exato");
    let opts = ResizeOptions::new().resize_alg(alg).crop(
        src.x as f64,
        src.y as f64,
        src.w as f64,
        src.h as f64,
    );
    Resizer::new()
        .resize(img, &mut dst, &opts)
        .expect("tipos de pixel iguais (U8x4)");
}

/// Buffer do IPC com o trecho `src` de `img` escalado para `out_w`x`out_h`.
pub fn view_buffer(img: &RgbaImage, src: Rect, out_w: u32, out_h: u32) -> Vec<u8> {
    let mut buf = vec![0u8; 8 + out_w as usize * out_h as usize * 4];
    buf[0..4].copy_from_slice(&out_w.to_le_bytes());
    buf[4..8].copy_from_slice(&out_h.to_le_bytes());
    resize_into(
        img,
        src,
        out_w,
        out_h,
        ResizeAlg::Convolution(FilterType::Bilinear),
        &mut buf[8..],
    );
    buf
}
