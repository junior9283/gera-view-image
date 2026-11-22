//! Luz linear e alcance estendido (OpenEXR, Radiance, PQ e HLG) levados a SDR.
//!
//! Regra única, sem opções: 1,0 é o branco de referência. Até [`KNEE`] nada muda; acima, o maior
//! canal é comprimido por um ombro de Reinhard que leva o pico da imagem exatamente a 1,0, e os
//! outros canais acompanham na mesma proporção (o matiz não gira). Imagem cujo pico já é 1,0 sai
//! idêntica: um EXR exportado pelo app reabre com as mesmas cores. Não há HDR real na tela.
use super::{
    cicp,
    decode::{Decoded, MAX_DECODE_BYTES, short},
    raster::Rgba16Image,
};
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::{DynamicImage, ImageDecoder, RgbaImage};
use rayon::prelude::*;
use std::io::Cursor;

/// Início do ombro, em luz linear.
const KNEE: f32 = 0.75;
/// Valores acima disso (infinitos inclusive) contam como isto.
const MAX_LINEAR: f32 = 1e6;
/// Branco de referência do SDR dentro do HDR (ITU-R BT.2408), em cd/m².
const REFERENCE_WHITE: f32 = 203.0;
/// Pico nominal da tela do HLG (ITU-R BT.2100), em cd/m², e o gama de sistema correspondente.
const HLG_PEAK: f32 = 1000.0;
const HLG_GAMMA: f32 = 1.2;

/// Curvas de alcance estendido do ITU-T H.273.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transfer {
    Pq,
    Hlg,
}

/// Valor utilizável: NaN e negativos viram 0, infinito vira o teto.
fn clean(v: f32) -> f32 {
    if v > 0.0 { v.min(MAX_LINEAR) } else { 0.0 }
}

fn max3(p: [f32; 3]) -> f32 {
    p[0].max(p[1]).max(p[2])
}

/// Comprime um pixel (já limpo) para 0..=1; `peak` é o maior canal da imagem.
fn compress(p: [f32; 3], peak: f32) -> [f32; 3] {
    let m = max3(p);
    if m <= KNEE {
        return p;
    }
    let span = 1.0 - KNEE;
    let (t, top) = ((m - KNEE) / span, (peak.max(1.0) - KNEE) / span);
    let out = (KNEE + span * t * (1.0 + t / (top * top)) / (1.0 + t)).min(1.0);
    p.map(|v| v * (out / m))
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Maior canal de cor dos pixels.
fn peak_of(px: &[[f32; 4]]) -> f32 {
    px.par_iter()
        .map(|p| max3([p[0], p[1], p[2]].map(clean)))
        .reduce(|| 0.0, f32::max)
}

/// RGBA em luz linear (alfa direto) para RGBA8 com a curva do sRGB. `peak`: ver [`compress`].
fn linear_to_rgba8(
    w: u32,
    h: u32,
    peak: f32,
    at: impl Fn(usize) -> [f32; 4] + Sync,
) -> RgbaImage {
    let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    let mut out = RgbaImage::new(w, h);
    out.as_chunks_mut::<4>().0.par_iter_mut().enumerate().for_each(|(i, o)| {
        let p = at(i).map(clean);
        let [r, g, b] = compress([p[0], p[1], p[2]], peak).map(srgb_encode);
        *o = [to8(r), to8(g), to8(b), to8(p[3])];
    });
    out
}

/// Recusa `w`x`h` com `bytes` por pixel acima do teto de decodificação.
pub(super) fn check_pixels(w: usize, h: usize, bytes: usize) -> AppResult<()> {
    w.checked_mul(h)
        .and_then(|n| n.checked_mul(bytes))
        .filter(|&n| n <= MAX_DECODE_BYTES)
        .map(|_| ())
        .ok_or_else(|| AppError::Unsupported(format!("imagem grande demais ({w}x{h})")))
}

// ---------- OpenEXR ----------

/// Primeira camada com R, G e B (ou só Y, que vira cinza), recortada na janela de exibição. O alfa
/// do OpenEXR é pré-multiplicado.
pub fn decode_exr(bytes: &[u8]) -> AppResult<Decoded> {
    use ::exr::{
        meta::header::Header,
        prelude::{MetaData, ReadChannels, ReadLayers, ReadSpecificChannel, Text, Vec2, read},
    };
    let meta = MetaData::read_from_buffered(Cursor::new(bytes), false).map_err(AppError::corrupt)?;
    // Os tamanhos vêm do arquivo: nada é alocado antes de conferi-los (janela de dados e bloco).
    for h in &meta.headers {
        check_pixels(h.layer_size.width(), h.layer_size.height(), 4)?;
        if h.max_block_byte_size() > MAX_DECODE_BYTES {
            return Err(AppError::Unsupported("bloco do EXR grande demais".into()));
        }
    }
    let has = |h: &Header, names: &[&str]| {
        !h.deep && names.iter().all(|n| h.channels.find_index_of_channel(&Text::from(*n)).is_some())
    };
    let color = meta.headers.iter().find(|h| has(h, &["R", "G", "B"]));
    let header = color
        .or_else(|| meta.headers.iter().find(|h| has(h, &["Y"])))
        .ok_or_else(|| AppError::Unsupported("EXR sem canais R, G e B ou Y".into()))?;
    let window = header.shared_attributes.display_window;
    let (w, h) = (window.size.width(), window.size.height());
    check_pixels(w, h, size_of::<[f32; 4]>())?;
    let origin = header.own_attributes.layer_position;
    let dx = i64::from(origin.x()) - i64::from(window.position.x());
    let dy = i64::from(origin.y()) - i64::from(window.position.y());
    // Fora da janela de exibição não aparece; onde não há dados fica transparente.
    let put = move |px: &mut Vec<[f32; 4]>, at: Vec2<usize>, v: [f32; 4]| {
        let (x, y) = (at.x() as i64 + dx, at.y() as i64 + dy);
        if (0..w as i64).contains(&x)
            && (0..h as i64).contains(&y)
            && let Some(p) = px.get_mut(y as usize * w + x as usize)
        {
            *p = v;
        }
    };
    let layers = read().no_deep_data().largest_resolution_level();
    let input = Cursor::new(bytes);
    macro_rules! pixels {
        ($channels:expr) => {
            $channels
                .first_valid_layer()
                .all_attributes()
                .from_buffered(input)
                .map_err(AppError::corrupt)?
                .layer_data
                .channel_data
                .pixels
        };
    }
    let mut px: Vec<[f32; 4]> = if color.is_some() {
        pixels!(layers.rgba_channels(
            move |_, _| vec![[0f32; 4]; w * h],
            move |px: &mut Vec<[f32; 4]>, at, (r, g, b, a): (f32, f32, f32, f32)| {
                put(px, at, [r, g, b, a])
            },
        ))
    } else {
        pixels!(layers.specific_channels().required("Y").optional("A", 1f32).collect_pixels(
            move |_, _| vec![[0f32; 4]; w * h],
            move |px: &mut Vec<[f32; 4]>, at, (y, a): (f32, f32)| put(px, at, [y, y, y, a]),
        ))
    };
    // O pico é o da cor pré-multiplicada: um brilho quase transparente não escurece a imagem.
    let peak = peak_of(&px);
    px.par_iter_mut().for_each(|p| {
        let a = clean(p[3]);
        if a > 0.0 && a < 1.0 {
            p[..3].iter_mut().for_each(|c| *c = clean(*c) / a);
        }
    });
    let icc = header.shared_attributes.chromaticities.and_then(|c| {
        let xy = |v: Vec2<f32>| (v.x(), v.y());
        cicp::icc_from_primaries([xy(c.red), xy(c.green), xy(c.blue)], xy(c.white), None)
    });
    let dpi = header.own_attributes.horizontal_density;
    let img = linear_to_rgba8(w as u32, h as u32, peak, |i| px[i]);
    Ok(Decoded {
        icc,
        dpi: dpi.filter(|d| d.is_finite() && *d > 0.0).map(|d| (d, d)),
        ..Decoded::single(img, SourceFormat::Exr)
    })
}

// ---------- Radiance ----------

/// Radiance RGBE (`.hdr`): primárias do sRGB presumidas; o `EXPOSURE` do cabeçalho é ignorado.
pub fn decode_radiance(bytes: &[u8]) -> AppResult<Decoded> {
    use ::image::codecs::hdr::HdrDecoder;
    let dec = HdrDecoder::new_nonstrict(Cursor::new(bytes))?;
    let (w, h) = dec.dimensions();
    // RGB em f32 mais o RGBA8 final.
    check_pixels(w as usize, h as usize, 16)?;
    let DynamicImage::ImageRgb32F(img) = DynamicImage::from_decoder(dec)? else {
        return Err(short());
    };
    let px = img.as_raw().as_chunks::<3>().0;
    let peak = px.par_iter().map(|p| max3(p.map(clean))).reduce(|| 0.0, f32::max);
    let out = linear_to_rgba8(w, h, peak, |i| [px[i][0], px[i][1], px[i][2], 1.0]);
    Ok(Decoded::single(out, SourceFormat::Hdr))
}

// ---------- PQ e HLG ----------

/// EOTF do PQ (SMPTE ST 2084) em múltiplos do branco de referência.
fn pq(v: f32) -> f32 {
    const M1: f32 = 2610.0 / 16384.0;
    const M2: f32 = 2523.0 / 32.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = 2413.0 / 128.0;
    const C3: f32 = 2392.0 / 128.0;
    let e = v.powf(1.0 / M2);
    ((e - C1).max(0.0) / (C2 - C3 * e)).powf(1.0 / M1) * 10_000.0 / REFERENCE_WHITE
}

/// Inversa da OETF do HLG (ARIB STD-B67): luz da cena, 0..=1.
fn hlg(v: f32) -> f32 {
    const A: f32 = 0.178_832_77;
    const B: f32 = 0.284_668_92;
    const C: f32 = 0.559_910_7;
    if v <= 0.5 {
        v * v / 3.0
    } else {
        (((v - C) / A).exp() + B) / 12.0
    }
}

/// Converte os códigos PQ ou HLG (0..=65535) para SDR com a curva do sRGB, nas mesmas primárias.
pub fn to_sdr(img: &mut Rgba16Image, transfer: Transfer) {
    const MAX: f32 = u16::MAX as f32;
    let curve: fn(f32) -> f32 = match transfer {
        Transfer::Pq => pq,
        Transfer::Hlg => hlg,
    };
    let lut: Vec<f32> = (0..=u16::MAX).map(|v| curve(v as f32 / MAX)).collect();
    let linear = |p: &[u16; 4]| {
        let rgb = [p[0], p[1], p[2]].map(|v| lut[v as usize]);
        match transfer {
            Transfer::Pq => rgb,
            Transfer::Hlg => {
                // OOTF: gama de sistema sobre a luminância (coeficientes do BT.2100).
                let y = 0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2];
                let k = HLG_PEAK / REFERENCE_WHITE * y.powf(HLG_GAMMA - 1.0);
                rgb.map(|v| v * k)
            }
        }
    };
    let peak = img
        .as_chunks::<4>()
        .0
        .par_iter()
        .map(|p| max3(linear(p)))
        .reduce(|| 0.0, f32::max);
    img.as_chunks_mut::<4>().0.par_iter_mut().for_each(|p| {
        let out = compress(linear(p), peak).map(srgb_encode);
        for (o, v) in p.iter_mut().zip(out) {
            *o = (v.clamp(0.0, 1.0) * MAX + 0.5) as u16;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ombro_e_identidade_ate_o_branco_e_monotono_acima() {
        for v in [0.0, 0.2, 0.75, 0.9, 1.0] {
            let out = compress([v, v / 2.0, 0.0], 1.0);
            assert!((out[0] - v).abs() < 1e-6 && (out[1] - v / 2.0).abs() < 1e-6, "{v}: {out:?}");
        }
        let mut last = 0.0;
        for i in 0..200 {
            let v = i as f32 / 10.0;
            let out = compress([v, 0.0, 0.0], 20.0)[0];
            assert!(out >= last && out <= 1.0, "{v}: {out} depois de {last}");
            last = out;
        }
        assert!((compress([20.0; 3], 20.0)[0] - 1.0).abs() < 1e-5, "o pico vira branco");
        assert_eq!(compress([0.5, 0.2, 0.1], 20.0), [0.5, 0.2, 0.1], "tons médios não mudam");
    }

    #[test]
    fn valores_impossiveis_nao_escapam() {
        let px = [[f32::NAN, f32::INFINITY, -3.0, f32::NAN], [0.2, 0.2, 0.2, 7.0]];
        let peak = peak_of(&px);
        assert_eq!(peak, MAX_LINEAR);
        let out = linear_to_rgba8(2, 1, peak, |i| px[i]);
        assert_eq!(out.get_pixel(0, 0).0, [0, 255, 0, 0]);
        assert_eq!(out.get_pixel(1, 0).0, [124, 124, 124, 255]);
    }

    #[test]
    fn branco_de_referencia_do_pq_e_do_hlg() {
        // BT.2408: 203 cd/m² é 58 % no PQ e 75 % no HLG.
        assert!((pq(0.580_6) - 1.0).abs() < 0.01, "{}", pq(0.580_6));
        assert!((pq(1.0) - 10_000.0 / 203.0).abs() < 0.1);
        let y = hlg(0.75).powf(HLG_GAMMA) * HLG_PEAK / REFERENCE_WHITE;
        assert!((y - 1.0).abs() < 0.02, "{y}");
        assert!((hlg(1.0) - 1.0).abs() < 1e-4);
    }
}
