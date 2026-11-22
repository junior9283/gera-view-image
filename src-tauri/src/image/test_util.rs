//! Auxiliares dos testes de codificação (gravar, reler e comparar).
use ::image::{Rgb, RgbImage, RgbaImage};

pub fn gradiente(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        Rgb([
            (x * 255 / w) as u8,
            (y * 255 / h) as u8,
            ((x + y) % 256) as u8,
        ])
    })
}

/// Gradiente com textura (ruído determinístico de ±16), parecido com uma foto: as taxas
/// de compressão com perdas passam a limitar o tamanho.
pub fn foto(w: u32, h: u32) -> RgbImage {
    let mut g = gradiente(w, h);
    let mut seed = 0x9E37_79B9u32;
    for p in g.pixels_mut() {
        for c in p.0.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *c = c.saturating_add((seed % 32) as u8).saturating_sub(16);
        }
    }
    g
}

/// PSNR (dB) dos canais RGB; `f64::INFINITY` se idênticas.
pub fn psnr(a: &RgbaImage, b: &RgbaImage) -> f64 {
    assert_eq!(a.dimensions(), b.dimensions());
    let (mut sum, mut n) = (0f64, 0f64);
    for (p, q) in a.pixels().zip(b.pixels()) {
        for c in 0..3 {
            let d = p[c] as f64 - q[c] as f64;
            sum += d * d;
            n += 1.0;
        }
    }
    if sum == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (255.0f64 * 255.0 / (sum / n)).log10()
}

/// Bytes com cara de perfil ICC (cabeçalho com `acsp`): os codificadores só os carregam.
pub fn icc_falso() -> Vec<u8> {
    let mut v = vec![0u8; 200];
    v[..4].copy_from_slice(&200u32.to_be_bytes());
    v[36..40].copy_from_slice(b"acsp");
    v[100] = 42;
    v
}

/// TIFF little-endian com um IFD0 `(tag, tipo, contagem, bytes do valor)`; valores com mais de
/// 4 bytes vão depois do IFD. Serve para montar EXIF e arquivos TIFF forjados nos testes.
pub fn tiff_le(entries: &[(u16, u16, u32, Vec<u8>)]) -> Vec<u8> {
    let n = entries.len();
    let extra_at = 8 + 2 + 12 * n + 4;
    let mut out = b"II*\0\x08\0\0\0".to_vec();
    out.extend_from_slice(&(n as u16).to_le_bytes());
    let mut tail = Vec::new();
    for (tag, ty, count, data) in entries {
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&ty.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        if data.len() <= 4 {
            let mut d = data.clone();
            d.resize(4, 0);
            out.extend_from_slice(&d);
        } else {
            out.extend_from_slice(&((extra_at + tail.len()) as u32).to_le_bytes());
            tail.extend_from_slice(data);
            if tail.len() % 2 == 1 {
                tail.push(0);
            }
        }
    }
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&tail);
    out
}
