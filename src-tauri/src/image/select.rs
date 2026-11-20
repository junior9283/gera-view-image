//! Seleção: Alfa Instantâneo (varinha por distância em Lab), laço magnético e rasterização.
use crate::doc::model::{Mask, Rect};
use crate::image::ops::mask_coverage;
use ::image::{GrayImage, RgbaImage};

/// Raio (px) da busca da borda no laço magnético.
const SNAP_RADIUS: i32 = 8;
/// Espaçamento (px) da reamostragem do caminho do laço magnético.
const SNAP_STEP: f32 = 4.0;

/// Codifica uma cobertura (`true` = dentro) em corridas alternadas, começando por "fora".
pub fn coverage_to_rle(cov: impl IntoIterator<Item = bool>) -> Vec<u32> {
    let mut rle = Vec::new();
    let (mut inside, mut run) = (false, 0u32);
    for c in cov {
        if c == inside {
            run += 1;
        } else {
            rle.push(run);
            inside = c;
            run = 1;
        }
    }
    rle.push(run);
    rle
}

/// Alfa 255 dentro da máscara, 0 fora.
pub fn mask_to_alpha(mask: &Mask, w: u32, h: u32) -> GrayImage {
    let cov = mask_coverage(mask, w, h);
    GrayImage::from_raw(
        w,
        h,
        cov.into_iter().map(|c| if c { 255 } else { 0 }).collect(),
    )
    .expect("buffer com o tamanho exato")
}

/// Menor retângulo que contém a máscara (`None` se estiver vazia).
pub fn mask_bounds(mask: &Mask, w: u32, h: u32) -> Option<Rect> {
    coverage_bounds(&mask_coverage(mask, w, h), w, h)
}

fn coverage_bounds(cov: &[bool], w: u32, h: u32) -> Option<Rect> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (i, _) in cov.iter().enumerate().filter(|(_, c)| **c) {
        let (x, y) = (i as u32 % w, i as u32 / w);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + 1);
        y1 = y1.max(y + 1);
    }
    (x1 > x0).then(|| Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

/// Recorte da região selecionada: o retângulo da máscara; fora dela (seleção não
/// retangular) o alfa fica 0. Sem máscara = imagem toda; máscara vazia = `None`.
pub fn extract_region(img: &RgbaImage, mask: Option<&Mask>) -> Option<RgbaImage> {
    let (w, h) = img.dimensions();
    let Some(mask) = mask else {
        return Some(img.clone());
    };
    let cov = mask_coverage(mask, w, h);
    let b = coverage_bounds(&cov, w, h)?;
    let mut out = ::image::imageops::crop_imm(img, b.x, b.y, b.w, b.h).to_image();
    if !matches!(mask, Mask::Rect(_)) {
        for (x, y, px) in out.enumerate_pixels_mut() {
            if !cov[((b.y + y) * w + b.x + x) as usize] {
                px.0[3] = 0;
            }
        }
    }
    Some(out)
}

fn lab([r, g, b]: [u8; 3]) -> [f32; 3] {
    let lin = |c: u8| {
        let c = c as f32 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(r), lin(g), lin(b));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f32| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Flood fill contíguo (4 vizinhos) a partir de `seed`: entra todo pixel cuja distância
/// em Lab (ΔE76) à cor da semente seja `<= tolerance * 100`.
pub fn instant_alpha(img: &RgbaImage, seed: (u32, u32), tolerance: f32) -> Mask {
    instant_alpha_counted(img, seed, tolerance).0
}

/// Como `instant_alpha`, mas também devolve quantos pixels foram convertidos para Lab.
/// O Lab é calculado sob demanda (semente e pixels visitados), nunca para a imagem toda:
/// a memória extra é 1 byte por pixel (estado), não 12.
pub fn instant_alpha_counted(img: &RgbaImage, seed: (u32, u32), tolerance: f32) -> (Mask, usize) {
    const UNSEEN: u8 = 0;
    const INSIDE: u8 = 1;
    const OUTSIDE: u8 = 2;
    let (w, h) = img.dimensions();
    let mut state = vec![UNSEEN; (w * h) as usize];
    let mut converted = 0usize;
    if seed.0 < w && seed.1 < h {
        let idx = |x: u32, y: u32| (y * w + x) as usize;
        let mut lab_at = |x: u32, y: u32| {
            converted += 1;
            let p = img.get_pixel(x, y).0;
            lab([p[0], p[1], p[2]])
        };
        let s = lab_at(seed.0, seed.1);
        let limit = tolerance.clamp(0.0, 1.0) * 100.0;
        let mut stack = vec![seed];
        state[idx(seed.0, seed.1)] = INSIDE;
        while let Some((x, y)) = stack.pop() {
            let nbrs = [
                (x > 0).then(|| (x - 1, y)),
                (x + 1 < w).then_some((x + 1, y)),
                (y > 0).then(|| (x, y - 1)),
                (y + 1 < h).then_some((x, y + 1)),
            ];
            for (nx, ny) in nbrs.into_iter().flatten() {
                let i = idx(nx, ny);
                if state[i] != UNSEEN {
                    continue;
                }
                let l = lab_at(nx, ny);
                let d =
                    ((l[0] - s[0]).powi(2) + (l[1] - s[1]).powi(2) + (l[2] - s[2]).powi(2)).sqrt();
                if d <= limit {
                    state[i] = INSIDE;
                    stack.push((nx, ny));
                } else {
                    state[i] = OUTSIDE;
                }
            }
        }
    }
    let mask = Mask::Bitmap {
        w,
        h,
        rle: coverage_to_rle(state.iter().map(|&s| s == INSIDE)),
    };
    (mask, converted)
}

/// Magnitude do gradiente de Sobel sobre a luminância.
fn sobel(img: &RgbaImage) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let luma: Vec<f32> = img
        .pixels()
        .map(|p| 0.299 * p.0[0] as f32 + 0.587 * p.0[1] as f32 + 0.114 * p.0[2] as f32)
        .collect();
    let at = |x: i32, y: i32| {
        let (x, y) = (
            x.clamp(0, w as i32 - 1) as usize,
            y.clamp(0, h as i32 - 1) as usize,
        );
        luma[y * w as usize + x]
    };
    let mut g = vec![0.0; (w * h) as usize];
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let gx = at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x - 1, y)
                - at(x - 1, y + 1);
            let gy = at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x, y - 1)
                - at(x + 1, y - 1);
            g[(y as u32 * w + x as u32) as usize] = (gx * gx + gy * gy).sqrt();
        }
    }
    g
}

/// Reamostra a polilinha em passos de `step` px (mantém o primeiro e o último ponto).
fn resample(points: &[(f32, f32)], step: f32) -> Vec<(f32, f32)> {
    let Some(&first) = points.first() else {
        return vec![];
    };
    let mut out = vec![first];
    let mut carried = 0.0f32; // distância já andada desde o último ponto emitido
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        if len == 0.0 {
            continue;
        }
        let mut pos = step - carried;
        while pos <= len {
            let t = pos / len;
            out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
            pos += step;
        }
        carried = len - (pos - step);
    }
    let last = *points.last().expect("não vazio");
    if out.last() != Some(&last) {
        out.push(last);
    }
    out
}

/// Laço magnético: reamostra o caminho a cada 4 px e move cada ponto ao máximo do gradiente
/// de Sobel num raio de 8 px (empate: o mais próximo do ponto original).
pub fn snap_lasso(img: &RgbaImage, points: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let (w, h) = img.dimensions();
    let grad = sobel(img);
    let r2 = (SNAP_RADIUS * SNAP_RADIUS) as f32;
    resample(points, SNAP_STEP)
        .into_iter()
        .map(|(px, py)| {
            let (cx, cy) = (px.floor() as i32, py.floor() as i32);
            let mut best = (f32::MIN, f32::MAX, (px, py));
            for dy in -SNAP_RADIUS..=SNAP_RADIUS {
                for dx in -SNAP_RADIUS..=SNAP_RADIUS {
                    let d2 = (dx * dx + dy * dy) as f32;
                    let (x, y) = (cx + dx, cy + dy);
                    if d2 > r2 || x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                        continue;
                    }
                    let g = grad[(y as u32 * w + x as u32) as usize];
                    let better = g > best.0 + 1e-3 || ((g - best.0).abs() <= 1e-3 && d2 < best.1);
                    if better {
                        best = (g, d2, (x as f32 + 0.5, y as f32 + 0.5));
                    }
                }
            }
            best.2
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::image::Rgba;

    fn bitmap_count(m: &Mask) -> usize {
        let Mask::Bitmap { w, h, .. } = m else {
            panic!("esperava Bitmap")
        };
        mask_coverage(m, *w, *h).iter().filter(|c| **c).count()
    }

    /// 40x40 branco com um quadrado vermelho 10x10 em (15,15).
    fn branco_com_vermelho() -> RgbaImage {
        let mut img = RgbaImage::from_pixel(40, 40, Rgba([255, 255, 255, 255]));
        for y in 15..25 {
            for x in 15..25 {
                img.put_pixel(x, y, Rgba([255, 0, 0, 255]));
            }
        }
        img
    }

    #[test]
    fn cobre_o_branco_contiguo_e_nao_o_vermelho() {
        let img = branco_com_vermelho();
        let m = instant_alpha(&img, (0, 0), 0.1);
        let cov = mask_coverage(&m, 40, 40);
        for y in 0..40u32 {
            for x in 0..40u32 {
                let vermelho = (15..25).contains(&x) && (15..25).contains(&y);
                assert_eq!(cov[(y * 40 + x) as usize], !vermelho, "({x},{y})");
            }
        }
    }

    #[test]
    fn tolerancia_zero_so_cor_identica() {
        let mut img = RgbaImage::from_pixel(10, 10, Rgba([100, 100, 100, 255]));
        img.put_pixel(5, 5, Rgba([101, 100, 100, 255]));
        assert_eq!(bitmap_count(&instant_alpha(&img, (0, 0), 0.0)), 99);
        assert_eq!(bitmap_count(&instant_alpha(&img, (0, 0), 0.1)), 100);
    }

    #[test]
    fn converte_para_lab_so_o_que_visita() {
        // Semente 3x3 cercada por uma moldura vermelha, numa imagem grande: o Lab só pode
        // ser calculado para a semente, a região e a vizinhança imediata (não w*h).
        let mut img = RgbaImage::from_pixel(200, 200, Rgba([255, 255, 255, 255]));
        for y in 98..103 {
            for x in 98..103 {
                let borda = x == 98 || x == 102 || y == 98 || y == 102;
                let cor = if borda {
                    [255, 0, 0, 255]
                } else {
                    [255, 255, 255, 255]
                };
                img.put_pixel(x, y, Rgba(cor));
            }
        }
        let (m, convertidos) = instant_alpha_counted(&img, (100, 100), 0.05);
        assert_eq!(bitmap_count(&m), 9);
        assert!(convertidos <= 1 + 9 + 12, "convertidos = {convertidos}");
    }

    #[test]
    fn so_regioes_contiguas() {
        // Faixa vermelha separa dois brancos; a semente só alcança o seu lado.
        let mut img = RgbaImage::from_pixel(9, 3, Rgba([255, 255, 255, 255]));
        for y in 0..3 {
            img.put_pixel(4, y, Rgba([255, 0, 0, 255]));
        }
        assert_eq!(bitmap_count(&instant_alpha(&img, (0, 0), 0.1)), 12);
    }

    #[test]
    fn semente_fora_da_imagem_gera_mascara_vazia() {
        let img = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        assert_eq!(bitmap_count(&instant_alpha(&img, (9, 9), 1.0)), 0);
    }

    #[test]
    fn snap_lasso_gruda_na_borda() {
        // Borda vertical em x=50: esquerda preta, direita branca.
        let mut img = RgbaImage::from_pixel(100, 100, Rgba([0, 0, 0, 255]));
        for y in 0..100 {
            for x in 50..100 {
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let pts: Vec<(f32, f32)> = (20..80).step_by(10).map(|y| (45.0, y as f32)).collect();
        let snapped = snap_lasso(&img, &pts);
        assert!(snapped.len() >= pts.len());
        for (x, _) in snapped {
            assert!((49.0..=51.0).contains(&x), "x = {x}");
        }
    }

    #[test]
    fn reamostra_a_cada_4_px() {
        let r = resample(&[(0.0, 0.0), (20.0, 0.0)], 4.0);
        assert_eq!(r.len(), 6);
        assert!((r[1].0 - 4.0).abs() < 1e-4);
    }

    #[test]
    fn extrai_regiao_com_alfa_fora_da_elipse() {
        let img = RgbaImage::from_pixel(20, 20, Rgba([9, 9, 9, 255]));
        let ell = Mask::Ellipse(Rect {
            x: 2,
            y: 2,
            w: 10,
            h: 10,
        });
        let r = extract_region(&img, Some(&ell)).unwrap();
        assert_eq!(r.dimensions(), (10, 10));
        assert_eq!(r.get_pixel(0, 0).0[3], 0);
        assert_eq!(r.get_pixel(5, 5).0[3], 255);
        let rect = Mask::Rect(Rect {
            x: 2,
            y: 2,
            w: 4,
            h: 3,
        });
        assert_eq!(
            extract_region(&img, Some(&rect)).unwrap().dimensions(),
            (4, 3)
        );
        assert_eq!(extract_region(&img, None).unwrap().dimensions(), (20, 20));
    }

    #[test]
    fn rle_alfa_e_limites() {
        assert_eq!(coverage_to_rle([true, true, false, true]), vec![0, 2, 1, 1]);
        let m = Mask::Rect(Rect {
            x: 2,
            y: 1,
            w: 3,
            h: 2,
        });
        let a = mask_to_alpha(&m, 10, 5);
        assert_eq!(a.get_pixel(2, 1).0[0], 255);
        assert_eq!(a.get_pixel(1, 1).0[0], 0);
        assert_eq!(
            mask_bounds(&m, 10, 5),
            Some(Rect {
                x: 2,
                y: 1,
                w: 3,
                h: 2
            })
        );
        let vazio = Mask::Rect(Rect {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        });
        assert_eq!(mask_bounds(&vazio, 10, 5), None);
    }
}
