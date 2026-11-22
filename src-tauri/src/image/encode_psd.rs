//! PSD achatado (Lote 11): só a imagem composta, 8 bits RGB, em RLE, com perfil, EXIF, IPTC, XMP
//! e resolução nos recursos. A transparência vai no 4º canal.
use super::encode::MetaCarry;
use crate::error::{AppError, AppResult};
use ::image::DynamicImage;
use rayon::prelude::*;
use std::borrow::Cow;

/// Lado máximo do PSD (acima disso só o PSB).
const MAX_SIDE: u32 = 30_000;

pub fn encode(
    px: &DynamicImage,
    meta: &MetaCarry,
    iptc: Option<&[u8]>,
    xmp: Option<&str>,
) -> AppResult<Vec<u8>> {
    let (w, h) = (px.width(), px.height());
    if w.max(h) > MAX_SIDE {
        return Err(AppError::Unsupported(format!("PSD vai até {MAX_SIDE} px de lado")));
    }
    let channels: usize = if px.color().has_alpha() { 4 } else { 3 };
    let rgba = match px {
        DynamicImage::ImageRgba8(i) => Cow::Borrowed(i),
        other => Cow::Owned(other.to_rgba8()),
    };

    let mut out = b"8BPS\0\x01\0\0\0\0\0\0".to_vec();
    out.extend((channels as u16).to_be_bytes());
    out.extend(h.to_be_bytes());
    out.extend(w.to_be_bytes());
    out.extend([0, 8, 0, 3]); // 8 bits por canal, RGB
    out.extend([0; 4]); // sem dados de modo de cor
    let res = resources(meta, iptc, xmp);
    out.extend((res.len() as u32).to_be_bytes());
    out.extend(res);
    out.extend([0; 4]); // sem camadas nem máscaras

    out.extend([0, 1]); // RLE (PackBits), uma linha por vez
    let (w, h) = (w as usize, h as usize);
    let rows: Vec<Vec<u8>> = (0..channels * h)
        .into_par_iter()
        .map(|k| {
            let (c, y) = (k / h, k % h);
            let line = &rgba.as_raw()[y * w * 4..(y + 1) * w * 4];
            packbits(&line.iter().skip(c).step_by(4).copied().collect::<Vec<u8>>())
        })
        .collect();
    for r in &rows {
        // No pior caso 30 000 px viram 30 235 bytes: cabe nos 16 bits.
        out.extend((r.len() as u16).to_be_bytes());
    }
    rows.iter().for_each(|r| out.extend_from_slice(r));
    Ok(out)
}

/// Blocos de recursos (`8BIM`): resolução 1005, IPTC 1028, ICC 1039, EXIF 1058 e XMP 1060.
fn resources(meta: &MetaCarry, iptc: Option<&[u8]>, xmp: Option<&str>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut put = |id: u16, data: &[u8]| {
        out.extend_from_slice(b"8BIM");
        out.extend(id.to_be_bytes());
        out.extend([0, 0]); // sem nome
        out.extend((data.len() as u32).to_be_bytes());
        out.extend_from_slice(data);
        if data.len() % 2 == 1 {
            out.push(0);
        }
    };
    if let Some((x, y)) = meta.dpi {
        // Ponto fixo 16.16 em ppp, e a unidade de exibição (1 = polegada).
        let axis = |d: f32| {
            let fixed = (d as f64 * 65536.0).round() as u32;
            [&fixed.to_be_bytes()[..], &[0, 1, 0, 1]].concat()
        };
        put(1005, &[axis(x), axis(y)].concat());
    }
    for (id, data) in [
        (1028, iptc),
        (1039, meta.icc.as_deref()),
        (1058, meta.exif.as_deref()),
        (1060, xmp.map(str::as_bytes)),
    ] {
        if let Some(d) = data {
            put(id, d);
        }
    }
    out
}

/// PackBits: `n` ≥ 0 copia n+1 bytes; `n` < 0 repete o próximo byte 1−n vezes.
fn packbits(row: &[u8]) -> Vec<u8> {
    let run_at = |i: usize| row[i..].iter().take(128).take_while(|&&b| b == row[i]).count();
    let mut out = Vec::with_capacity(row.len() / 2 + 2);
    let mut i = 0;
    while i < row.len() {
        let run = run_at(i);
        if run >= 3 {
            out.extend([(1 - run as i16) as u8, row[i]]);
            i += run;
            continue;
        }
        let start = i;
        while i < row.len() && i - start < 128 && run_at(i) < 3 {
            i += 1;
        }
        out.push((i - start - 1) as u8);
        out.extend_from_slice(&row[start..i]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{decode::decode_bytes, test_util::gradiente};
    use std::path::Path;

    #[test]
    fn volta_identico_com_e_sem_alfa() {
        let mut img = DynamicImage::ImageRgb8(gradiente(67, 41)).into_rgba8();
        // Corridas longas, curtas e linha lisa: todos os caminhos do PackBits.
        for x in 0..67 {
            img.put_pixel(x, 3, ::image::Rgba([9, 9, 9, 255]));
            img.put_pixel(x, 4, ::image::Rgba([x as u8 / 3, 1, (x % 2) as u8, 255]));
        }
        let rgb = DynamicImage::ImageRgba8(img.clone()).to_rgb8();
        let out = encode(&DynamicImage::ImageRgb8(rgb), &MetaCarry::default(), None, None).unwrap();
        let d = decode_bytes(Path::new("x.psd"), &out).unwrap();
        assert_eq!(d.frames[0], img);

        img.put_pixel(5, 5, ::image::Rgba([10, 20, 30, 0]));
        img.put_pixel(6, 5, ::image::Rgba([10, 20, 30, 128]));
        let px = DynamicImage::ImageRgba8(img.clone());
        let out = encode(&px, &MetaCarry::default(), None, None).unwrap();
        let d = decode_bytes(Path::new("x.psd"), &out).unwrap();
        assert_eq!(d.frames[0], img);
    }

    #[test]
    fn packbits_decodifica_de_volta() {
        let unpack = |b: &[u8]| {
            let (mut out, mut i) = (Vec::new(), 0);
            while i < b.len() {
                let n = b[i] as i8;
                if n >= 0 {
                    out.extend_from_slice(&b[i + 1..i + 2 + n as usize]);
                    i += 2 + n as usize;
                } else {
                    out.extend(std::iter::repeat_n(b[i + 1], (1 - n as i16) as usize));
                    i += 2;
                }
            }
            out
        };
        let cases: [Vec<u8>; 5] = [
            vec![7; 1000],
            (0..=255).chain(0..=255).collect(),
            vec![1],
            [vec![1, 1, 2, 2, 2, 3], vec![4; 129], vec![5, 6]].concat(),
            vec![0, 0],
        ];
        for c in cases {
            assert_eq!(unpack(&packbits(&c)), c);
        }
    }

    #[test]
    fn leva_perfil_resolucao_e_metadados() {
        let meta = MetaCarry {
            icc: Some(vec![1, 2, 3]),
            exif: Some(b"II*\0xx".to_vec()),
            dpi: Some((300.0, 150.0)),
            ..Default::default()
        };
        let px = DynamicImage::ImageRgb8(gradiente(4, 4));
        let out = encode(&px, &meta, Some(b"iptc"), Some("<x/>")).unwrap();
        let has = |b: &[u8]| out.windows(b.len()).any(|w| w == b);
        assert!(has(b"8BIM\x04\x0f\0\0\0\0\0\x03\x01\x02\x03\0"), "ICC com enchimento");
        assert!(has(b"8BIM\x03\xed\0\0\0\0\0\x10\x01\x2c\0\0\0\x01\0\x01\0\x96\0\0\0\x01\0\x01"));
        assert!(has(b"8BIM\x04\x04\0\0\0\0\0\x04iptc"));
        assert!(has(b"8BIM\x04\x22\0\0\0\0\0\x06II*\0xx"));
        assert!(has(b"8BIM\x04\x24\0\0\0\0\0\x04<x/>"));
    }

    #[test]
    fn grande_demais_e_recusado() {
        let px = DynamicImage::new_rgb8(MAX_SIDE + 1, 1);
        assert_eq!(encode(&px, &MetaCarry::default(), None, None).unwrap_err().code(), "unsupported");
    }
}
