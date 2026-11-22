//! Operações não destrutivas: cada `Op` gera uma imagem nova a partir da anterior.
use crate::doc::model::{CropSpec, Mask, Op, Rect, ResizeFilter};
use ::image::{RgbaImage, imageops};
use rayon::prelude::*;

/// Aplica uma operação.
pub fn apply(img: &RgbaImage, op: &Op) -> RgbaImage {
    match op {
        Op::Rotate { quarter_turns } => match quarter_turns.rem_euclid(4) {
            1 => imageops::rotate90(img),
            2 => imageops::rotate180(img),
            3 => imageops::rotate270(img),
            _ => img.clone(),
        },
        Op::FlipH => imageops::flip_horizontal(img),
        Op::FlipV => imageops::flip_vertical(img),
        Op::Crop(c) => crop(img, c),
        Op::Resize { w, h, filter, .. } => resize(img, *w, *h, *filter),
        Op::Adjust(adj) => crate::image::color::adjust(img, adj),
        Op::Erase(mask) => masked(img, mask, |p, cov| {
            if cov {
                *p = [0, 0, 0, 0];
            }
        }),
        Op::MakeTransparent(mask) => masked(img, mask, |p, cov| {
            if cov {
                p[3] = 0;
            }
        }),
        Op::Composite { png, .. } => composite(img, png),
        Op::AssignProfile { .. } => img.clone(),
        Op::OnPage { op, .. } => apply(img, op),
    }
}

/// Recorte; com máscara, o que está fora dela fica com alfa 0 (RGB preservado).
fn crop(img: &RgbaImage, c: &CropSpec) -> RgbaImage {
    let (w, h) = img.dimensions();
    let r = clamp_rect(c.rect, w, h);
    let mut out = imageops::crop_imm(img, r.x, r.y, r.w, r.h).to_image();
    if let Some(mask) = &c.mask {
        let cov = mask_coverage(mask, w, h);
        for (x, y, px) in out.enumerate_pixels_mut() {
            if !cov[((r.y + y) * w + r.x + x) as usize] {
                px.0[3] = 0;
            }
        }
    }
    out
}

/// Dimensões depois da operação, sem calcular pixels.
pub fn output_size((w, h): (u32, u32), op: &Op) -> (u32, u32) {
    match op {
        Op::Rotate { quarter_turns } if quarter_turns.rem_euclid(2) == 1 => (h, w),
        Op::Crop(c) => {
            let r = clamp_rect(c.rect, w, h);
            (r.w, r.h)
        }
        Op::Resize { w, h, .. } => (*w, *h),
        Op::OnPage { op, .. } => output_size((w, h), op),
        _ => (w, h),
    }
}

/// Explica por que a operação não pode ser aplicada numa imagem `w`x`h`, se for o caso.
pub fn validate((w, h): (u32, u32), op: &Op) -> Result<(), String> {
    match op {
        Op::Crop(CropSpec { rect: r, .. }) if r.x >= w || r.y >= h || r.w == 0 || r.h == 0 => {
            Err("recorte fora da imagem".into())
        }
        Op::Resize { w, h, .. } if *w == 0 || *h == 0 => Err("tamanho zero".into()),
        Op::Resize { w, h, .. } if (*w as u64) * (*h as u64) > 1 << 31 => {
            Err("tamanho grande demais".into())
        }
        Op::OnPage { op, .. } => validate((w, h), op),
        _ => Ok(()),
    }
}

/// Interseção do retângulo com a imagem (pelo menos 1x1 quando a imagem não é vazia).
pub fn clamp_rect(r: Rect, w: u32, h: u32) -> Rect {
    let x = r.x.min(w.saturating_sub(1));
    let y = r.y.min(h.saturating_sub(1));
    Rect {
        x,
        y,
        w: r.w.min(w - x).max(1).min(w),
        h: r.h.min(h - y).max(1).min(h),
    }
}

/// Redimensiona com `fast_image_resize` (alfa pré-multiplicado internamente).
pub fn resize(img: &RgbaImage, w: u32, h: u32, filter: ResizeFilter) -> RgbaImage {
    let alg = resize_alg(filter);
    let mut out = vec![0u8; w as usize * h as usize * 4];
    crate::image::thumb::resize_into(
        img,
        Rect {
            x: 0,
            y: 0,
            w: img.width(),
            h: img.height(),
        },
        w,
        h,
        alg,
        &mut out,
    );
    RgbaImage::from_raw(w, h, out).expect("buffer com o tamanho exato")
}

/// Algoritmo do `fast_image_resize` para o filtro.
pub fn resize_alg(filter: ResizeFilter) -> fast_image_resize::ResizeAlg {
    use fast_image_resize::{FilterType, ResizeAlg};
    match filter {
        ResizeFilter::Nearest => ResizeAlg::Nearest,
        ResizeFilter::Bilinear => ResizeAlg::Convolution(FilterType::Bilinear),
        ResizeFilter::Lanczos3 => ResizeAlg::Convolution(FilterType::Lanczos3),
    }
}

/// Percorre as linhas em paralelo, chamando `f(pixel, dentro_da_mascara)`.
fn masked(img: &RgbaImage, mask: &Mask, f: impl Fn(&mut [u8; 4], bool) + Sync) -> RgbaImage {
    let (w, h) = img.dimensions();
    let cov = mask_coverage(mask, w, h);
    let mut out = img.clone();
    out.par_chunks_exact_mut(w as usize * 4)
        .zip(cov.par_chunks_exact(w as usize))
        .for_each(|(row, c)| {
            for (px, &inside) in row.as_chunks_mut::<4>().0.iter_mut().zip(c) {
                f(px, inside);
            }
        });
    out
}

/// Máscara rasterizada (`true` = dentro), um valor por pixel em ordem de linha.
/// Um pixel está dentro quando o centro dele está dentro da forma.
pub fn mask_coverage(mask: &Mask, w: u32, h: u32) -> Vec<bool> {
    let (wu, hu) = (w as usize, h as usize);
    let mut cov = vec![false; wu * hu];
    match mask {
        Mask::Rect(r) => {
            for y in r.y.min(h)..r.y.saturating_add(r.h).min(h) {
                let row = y as usize * wu;
                cov[row + r.x.min(w) as usize..row + r.x.saturating_add(r.w).min(w) as usize]
                    .fill(true);
            }
        }
        Mask::Ellipse(r) => {
            let (rx, ry) = (r.w as f64 / 2.0, r.h as f64 / 2.0);
            let (cx, cy) = (r.x as f64 + rx, r.y as f64 + ry);
            cov.par_chunks_exact_mut(wu)
                .enumerate()
                .for_each(|(y, row)| {
                    let dy = (y as f64 + 0.5 - cy) / ry;
                    if dy.abs() > 1.0 || rx == 0.0 {
                        return;
                    }
                    let half = rx * (1.0 - dy * dy).sqrt();
                    for (x, c) in row.iter_mut().enumerate() {
                        *c = ((x as f64 + 0.5) - cx).abs() <= half;
                    }
                });
        }
        Mask::Polygon(pts) => {
            // Varredura par-ímpar pelo centro de cada linha.
            cov.par_chunks_exact_mut(wu)
                .enumerate()
                .for_each(|(y, row)| {
                    let yc = y as f32 + 0.5;
                    let mut xs: Vec<f32> = Vec::new();
                    for i in 0..pts.len() {
                        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                        if (a.1 <= yc) != (b.1 <= yc) {
                            xs.push(a.0 + (yc - a.1) / (b.1 - a.1) * (b.0 - a.0));
                        }
                    }
                    xs.sort_by(f32::total_cmp);
                    for pair in xs.as_chunks::<2>().0 {
                        let x0 = (pair[0] - 0.5).ceil().max(0.0) as usize;
                        let x1 = (pair[1] - 0.5).ceil().clamp(0.0, wu as f32) as usize;
                        if x0 < x1 {
                            row[x0..x1].fill(true);
                        }
                    }
                });
        }
        Mask::Bitmap { w: mw, h: mh, rle } => {
            // Máscara de outro tamanho (não deveria acontecer): só a interseção conta.
            let (mw, mh) = (*mw as usize, *mh as usize);
            let (mut pos, mut inside) = (0usize, false);
            for &run in rle {
                let end = (pos + run as usize).min(mw * mh);
                if inside {
                    for i in pos..end {
                        let (x, y) = (i % mw, i / mw);
                        if x < wu && y < hu {
                            cov[y * wu + x] = true;
                        }
                    }
                }
                pos = end;
                inside = !inside;
            }
        }
    }
    cov
}

/// Compõe um PNG RGBA por cima (src-over), escalado ao tamanho da imagem se preciso.
fn composite(img: &RgbaImage, png: &[u8]) -> RgbaImage {
    let Ok(over) = ::image::load_from_memory_with_format(png, ::image::ImageFormat::Png) else {
        // PNG inválido não deveria chegar aqui (a interface gera o PNG); não altera a imagem.
        return img.clone();
    };
    let mut over = over.into_rgba8();
    if over.dimensions() != img.dimensions() {
        over = resize(&over, img.width(), img.height(), ResizeFilter::Bilinear);
    }
    let mut out = img.clone();
    out.par_chunks_exact_mut(4)
        .zip(over.par_chunks_exact(4))
        .for_each(|(d, s)| {
            let sa = s[3] as u32;
            if sa == 0 {
                return;
            }
            let da = d[3] as u32;
            let oa = sa * 255 + da * (255 - sa); // alfa de saída * 255
            if oa == 0 {
                return;
            }
            for c in 0..3 {
                let v = (s[c] as u32 * sa * 255 + d[c] as u32 * da * (255 - sa)) / oa;
                d[c] = v as u8;
            }
            d[3] = (oa / 255) as u8;
        });
    out
}
