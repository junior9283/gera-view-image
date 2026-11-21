//! Ajustes de cor, histograma e níveis automáticos.
use crate::doc::model::{ColorAdjust, Levels};
use crate::image::thumb::{HEADER_LEN, view_buffer_size};
use crate::image::raster::Rgba16Image;
use ::image::RgbaImage;
use rayon::prelude::*;
use serde::Serialize;

/// Histograma de 256 faixas por canal e luminância.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Histogram {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub l: Vec<u32>,
}

/// sRGB (0..1) -> linear.
fn decode(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// Linear -> sRGB (0..1).
fn encode(v: f32) -> f32 {
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

fn luma_u8(p: &[u8]) -> usize {
    ((2126 * p[0] as u32 + 7152 * p[1] as u32 + 722 * p[2] as u32 + 5000) / 10000) as usize
}

/// Histograma de pixels RGBA crus (ex.: o RGBA de um buffer do IPC).
pub fn histogram(rgba: &[u8]) -> Histogram {
    let mut h = Histogram { r: vec![0; 256], g: vec![0; 256], b: vec![0; 256], l: vec![0; 256] };
    for p in rgba.chunks_exact(4) {
        h.r[p[0] as usize] += 1;
        h.g[p[1] as usize] += 1;
        h.b[p[2] as usize] += 1;
        h.l[luma_u8(p).min(255)] += 1;
    }
    h
}

/// Níveis que esticam a luminância entre os percentis 0,5 % e 99,5 %.
pub fn auto_levels(rgba: &[u8]) -> ColorAdjust {
    let h = histogram(rgba);
    let n: u64 = h.l.iter().map(|&c| c as u64).sum();
    if n == 0 {
        return ColorAdjust::default();
    }
    let at = |frac: f64| {
        let alvo = (n as f64 * frac).ceil().max(1.0) as u64;
        let mut acc = 0u64;
        for (i, &c) in h.l.iter().enumerate() {
            acc += c as u64;
            if acc >= alvo {
                return i as u8;
            }
        }
        255
    };
    let (black, mut white) = (at(0.005), at(0.995));
    if white <= black {
        white = black.saturating_add(1).max(white);
    }
    ColorAdjust { levels: Levels { black, gamma: 1.0, white }, ..Default::default() }
}

/// Aplica `adjust` ao RGBA de um buffer do IPC (`u32 LE w`, `u32 LE h`, RGBA), no lugar.
pub fn adjust_view_buffer(buf: &mut [u8], a: &ColorAdjust) {
    if let Some((w, h)) = view_buffer_size(buf) {
        adjust_in_place(&mut buf[HEADER_LEN..], w, h, a);
    }
}

/// Aplica todos os ajustes, na ordem fixa: níveis, exposição, contraste, realces/sombras,
/// temperatura/matiz, saturação, sépia e nitidez. O alfa não muda.
pub fn adjust(img: &RgbaImage, a: &ColorAdjust) -> RgbaImage {
    let mut out = img.clone();
    let (w, h) = out.dimensions();
    adjust_in_place(&mut out, w, h, a);
    out
}

/// `adjust` em RGBA de 16 bits por canal (Salvar de PNG/TIFF de 16 bits): mesma conta, em f32.
pub fn adjust16(img: &Rgba16Image, a: &ColorAdjust) -> Rgba16Image {
    let mut out = img.clone();
    let (w, h) = out.dimensions();
    adjust_in_place(&mut out, w, h, a);
    out
}

/// Canal de 8 ou 16 bits.
trait Sample: Copy + Into<f32> + Send + Sync {
    const MAX: f32;
    /// `v` já em 0..=MAX (conversão truncada, como `as`).
    fn from_f32(v: f32) -> Self;
}

impl Sample for u8 {
    const MAX: f32 = 255.0;
    fn from_f32(v: f32) -> Self {
        v as u8
    }
}

impl Sample for u16 {
    const MAX: f32 = 65535.0;
    fn from_f32(v: f32) -> Self {
        v as u16
    }
}

/// `adjust` sobre RGBA cru de `w`x`h`, no lugar.
fn adjust_in_place<T: Sample>(px: &mut [T], w: u32, h: u32, a: &ColorAdjust) {
    if *a == ColorAdjust::default() {
        return;
    }
    // Só a nitidez ligada: pula a passada por pixel.
    if (ColorAdjust { sharpness: 0.0, ..*a }) != ColorAdjust::default() {
        px.par_chunks_exact_mut(4 * w.max(1) as usize).for_each(|row| {
            for p in row.chunks_exact_mut(4) {
                let c = pixel(a, [p[0], p[1], p[2]].map(|v| Into::<f32>::into(v) / T::MAX));
                for (d, v) in p.iter_mut().zip(c) {
                    *d = T::from_f32(v * T::MAX + 0.5);
                }
            }
        });
    }
    if a.sharpness > 0.0 {
        unsharp(px, w, h, a.sharpness.clamp(0.0, 1.0));
    }
}

/// Ajustes de um pixel RGB em 0..1 (o resultado também fica em 0..1).
fn pixel(a: &ColorAdjust, mut c: [f32; 3]) -> [f32; 3] {

    // 1. Níveis
    let lv = a.levels;
    if lv != Levels::default() {
        let (b, wh) = (lv.black as f32 / 255.0, (lv.white as f32 / 255.0).max(lv.black as f32 / 255.0 + 1.0 / 255.0));
        let inv_g = 1.0 / lv.gamma.max(0.01);
        c = c.map(|v| ((v - b) / (wh - b)).clamp(0.0, 1.0).powf(inv_g));
    }
    // 2. Exposição, em luz linear
    if a.exposure != 0.0 {
        let k = 2f32.powf(a.exposure.clamp(-3.0, 3.0));
        c = c.map(|v| encode((decode(v) * k).min(1.0)));
    }
    // 3. Contraste (curva S)
    let ct = a.contrast.clamp(-1.0, 1.0);
    if ct > 0.0 {
        c = c.map(|v| v + ct * (v * v * (3.0 - 2.0 * v) - v));
    } else if ct < 0.0 {
        c = c.map(|v| v * (1.0 + ct) - 0.5 * ct);
    }
    // 4. Realces e sombras, por máscaras de luminância
    if a.highlights != 0.0 || a.shadows != 0.0 {
        let l = luma(c[0], c[1], c[2]).clamp(0.0, 1.0);
        let (mh, ms) = (l * l, (1.0 - l) * (1.0 - l));
        let (hl, sh) = (a.highlights.clamp(-1.0, 1.0), a.shadows.clamp(-1.0, 1.0));
        c = c.map(|v| {
            let dh = hl * 0.5 * mh * if hl > 0.0 { 1.0 - v } else { v };
            let ds = sh * 0.5 * ms * if sh > 0.0 { 1.0 - v } else { v };
            v + dh + ds
        });
    }
    // 5. Temperatura e matiz (escala dos canais em torno de 6500 K)
    if a.temperature != 0.0 || a.tint != 0.0 {
        let (t, ti) = (a.temperature.clamp(-1.0, 1.0), a.tint.clamp(-1.0, 1.0));
        c[0] *= 1.0 + 0.25 * t + 0.1 * ti;
        c[1] *= 1.0 - 0.25 * ti;
        c[2] *= 1.0 - 0.25 * t + 0.1 * ti;
    }
    c = c.map(|v| v.clamp(0.0, 1.0));
    // 6. Saturação, em HSL
    if a.saturation != 0.0 {
        c = saturate(c, a.saturation.clamp(-1.0, 1.0));
    }
    // 7. Sépia
    if a.sepia > 0.0 {
        let s = a.sepia.clamp(0.0, 1.0);
        let [r, g, b] = c;
        let sep = [
            0.393 * r + 0.769 * g + 0.189 * b,
            0.349 * r + 0.686 * g + 0.168 * b,
            0.272 * r + 0.534 * g + 0.131 * b,
        ];
        c = [0, 1, 2].map(|i| (c[i] + s * (sep[i] - c[i])).clamp(0.0, 1.0));
    }
    c
}

fn saturate([r, g, b]: [f32; 3], amount: f32) -> [f32; 3] {
    let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
    let l = (mx + mn) / 2.0;
    let d = mx - mn;
    if d <= f32::EPSILON {
        return [r, g, b];
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs()).max(f32::EPSILON);
    let h = if mx == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if mx == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    let s = (s * (1.0 + amount)).clamp(0.0, 1.0);
    let ch = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = ch * (1.0 - (h % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match h as u32 {
        0 => (ch, x, 0.0),
        1 => (x, ch, 0.0),
        2 => (0.0, ch, x),
        3 => (0.0, x, ch),
        4 => (x, 0.0, ch),
        _ => (ch, 0.0, x),
    };
    let m = l - ch / 2.0;
    [r1 + m, g1 + m, b1 + m]
}

/// *Unsharp mask* de raio 1 (desfoque 3x3 binomial), `amount` em 0..1.
fn unsharp<T: Sample>(px: &mut [T], w: u32, h: u32, amount: f32) {
    let (w, h) = (w as usize, h as usize);
    if w < 3 || h < 3 {
        return;
    }
    let src = px.to_vec();
    // Pesos inteiros e soma em f32: exata para 8 e 16 bits (< 2^24).
    const K: [[f32; 3]; 3] = [[1.0, 2.0, 1.0], [2.0, 4.0, 2.0], [1.0, 2.0, 1.0]];
    px.par_chunks_exact_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            for ch in 0..3 {
                let mut acc = 0f32;
                for (dy, kr) in K.iter().enumerate() {
                    let yy = (y + dy).saturating_sub(1).min(h - 1);
                    for (dx, k) in kr.iter().enumerate() {
                        let xx = (x + dx).saturating_sub(1).min(w - 1);
                        acc += k * Into::<f32>::into(src[(yy * w + xx) * 4 + ch]);
                    }
                }
                let blur = acc / 16.0;
                let orig: f32 = src[(y * w + x) * 4 + ch].into();
                row[x * 4 + ch] = T::from_f32((orig + amount * 2.0 * (orig - blur)).clamp(0.0, T::MAX).round());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::image::Rgba;

    fn solid(w: u32, h: u32, p: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(p))
    }

    #[test]
    fn ajuste_neutro_e_identidade() {
        let img = RgbaImage::from_fn(16, 16, |x, y| Rgba([x as u8 * 16, y as u8 * 16, 77, 200]));
        assert_eq!(adjust(&img, &ColorAdjust::default()).as_raw(), img.as_raw());
    }

    #[test]
    fn exposicao_mais_1_dobra_linear() {
        // sRGB 0,5370 ~ linear 0,25
        let v = (encode(0.25) * 255.0).round() as u8;
        let a = ColorAdjust { exposure: 1.0, ..Default::default() };
        let out = adjust(&solid(2, 2, [v, v, v, 255]), &a);
        let lin = decode(out.get_pixel(0, 0)[0] as f32 / 255.0);
        assert!((lin - 0.5).abs() < 0.01, "linear = {lin}");
    }

    #[test]
    fn saturacao_menos_1_gera_cinza() {
        let a = ColorAdjust { saturation: -1.0, ..Default::default() };
        let out = adjust(&solid(2, 2, [200, 40, 90, 255]), &a);
        let p = out.get_pixel(1, 1);
        assert!(p[0] == p[1] && p[1] == p[2], "{p:?}");
        assert_eq!(p[3], 255);
    }

    #[test]
    fn auto_levels_estica_histograma() {
        let img = RgbaImage::from_fn(151, 10, |x, _| {
            let v = 50 + x as u8;
            Rgba([v, v, v, 255])
        });
        let a = auto_levels(img.as_raw());
        assert!((a.levels.black as i32 - 50).abs() <= 3, "{:?}", a.levels);
        assert!((a.levels.white as i32 - 200).abs() <= 3, "{:?}", a.levels);
        assert_eq!(a.exposure, 0.0);
    }

    #[test]
    fn histogram_soma_igual_pixels() {
        let img = RgbaImage::from_fn(13, 7, |x, y| Rgba([x as u8, y as u8, 3, 255]));
        let h = histogram(img.as_raw());
        for c in [&h.r, &h.g, &h.b, &h.l] {
            assert_eq!(c.len(), 256);
            assert_eq!(c.iter().sum::<u32>(), 13 * 7);
        }
    }

    #[test]
    fn ajuste_no_buffer_do_ipc_igual_ao_da_imagem() {
        use crate::doc::model::Rect;
        use crate::image::thumb::view_buffer;
        let img = RgbaImage::from_fn(37, 23, |x, y| Rgba([(x * 7) as u8, (y * 11) as u8, (x ^ y) as u8, 180]));
        let a = ColorAdjust {
            exposure: 0.4,
            contrast: 0.3,
            saturation: -0.2,
            sepia: 0.25,
            sharpness: 0.6,
            levels: Levels { black: 10, gamma: 1.2, white: 240 },
            ..Default::default()
        };
        let mut buf = view_buffer(&img, Rect { x: 0, y: 0, w: 37, h: 23 }, 37, 23);
        adjust_view_buffer(&mut buf, &a);
        assert_eq!(&buf[HEADER_LEN..], adjust(&img, &a).as_raw().as_slice());
        // Cabeçalho inconsistente: não mexe.
        let mut ruim = buf.clone();
        ruim.pop();
        let antes = ruim.clone();
        adjust_view_buffer(&mut ruim, &a);
        assert_eq!(ruim, antes);
    }

    #[test]
    fn sepia_e_nitidez_preservam_alfa_e_tamanho() {
        let img = solid(8, 8, [100, 120, 140, 99]);
        let a = ColorAdjust { sepia: 1.0, sharpness: 1.0, ..Default::default() };
        let out = adjust(&img, &a);
        assert_eq!(out.dimensions(), (8, 8));
        assert_eq!(out.get_pixel(3, 3)[3], 99);
    }
}
