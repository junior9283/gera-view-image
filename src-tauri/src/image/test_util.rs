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

/// Pasta temporária própria, apagada no fim do teste.
pub struct TempDir(std::path::PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let d = std::env::temp_dir().join(format!("gvi-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Perfil CMYK de saída mínimo (`mft1`, PCS Lab) que só usa tinta preta: K = 1 - L na ida e
/// L = 1 - K na volta.
pub fn cmyk_profile(name: &str) -> Vec<u8> {
    let lut8 = |i: u8, o: u8, clut: &[u8]| {
        let mut b = b"mft1\0\0\0\0".to_vec();
        b.extend([i, o, 2, 0]);
        for k in 0..9u32 {
            b.extend((if k % 4 == 0 { 0x1_0000u32 } else { 0 }).to_be_bytes());
        }
        (0..i).for_each(|_| b.extend(0..=255u8));
        b.extend_from_slice(clut);
        (0..o).for_each(|_| b.extend(0..=255u8));
        b.resize(b.len().next_multiple_of(4), 0);
        b
    };
    // A última entrada (K, b*) é a que varia mais rápido.
    let a2b: Vec<u8> = (0..16).flat_map(|i| [if i & 1 == 1 { 0 } else { 255 }, 128, 128]).collect();
    let b2a: Vec<u8> = (0..8).flat_map(|i| [0, 0, 0, if i & 4 == 4 { 0 } else { 255 }]).collect();
    let units: Vec<u16> = name.encode_utf16().collect();
    let mut desc = b"mluc\0\0\0\0".to_vec();
    for v in [1u32, 12] {
        desc.extend(v.to_be_bytes());
    }
    desc.extend(b"enUS");
    for v in [units.len() as u32 * 2, 28] {
        desc.extend(v.to_be_bytes());
    }
    units.iter().for_each(|u| desc.extend(u.to_be_bytes()));
    desc.resize(desc.len().next_multiple_of(4), 0);
    let mut white = b"XYZ \0\0\0\0".to_vec();
    for v in [0xF6D6u32, 0x1_0000, 0xD32D] {
        white.extend(v.to_be_bytes());
    }
    let tags: [(&[u8; 4], Vec<u8>); 4] =
        [(b"desc", desc), (b"wtpt", white), (b"A2B0", lut8(4, 3, &a2b)), (b"B2A0", lut8(3, 4, &b2a))];
    let mut head = vec![0u8; 128];
    head[8..12].copy_from_slice(&0x0420_0000u32.to_be_bytes());
    head[12..24].copy_from_slice(b"prtrCMYKLab ");
    head[36..40].copy_from_slice(b"acsp");
    for (i, v) in [0xF6D6u32, 0x1_0000, 0xD32D].into_iter().enumerate() {
        head[68 + i * 4..72 + i * 4].copy_from_slice(&v.to_be_bytes());
    }
    head.extend((tags.len() as u32).to_be_bytes());
    let mut at = head.len() + tags.len() * 12;
    let mut body = Vec::new();
    for (sig, data) in &tags {
        head.extend_from_slice(*sig);
        head.extend((at as u32).to_be_bytes());
        head.extend((data.len() as u32).to_be_bytes());
        at += data.len();
        body.extend_from_slice(data);
    }
    head.extend(body);
    let n = head.len() as u32;
    head[..4].copy_from_slice(&n.to_be_bytes());
    head
}
