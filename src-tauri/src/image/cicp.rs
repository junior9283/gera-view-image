//! Cor sem ICC: pontos de código CICP (nclx do HEIF/AVIF, `cICP` do PNG, JPEG XL) e `sRGB`,
//! `gAMA` e `cHRM` do PNG, na precedência da especificação PNG (3ª edição, 4.3):
//! `cICP` > `iCCP` > `sRGB` > `gAMA`/`cHRM`.
//!
//! O resultado é um perfil ICC sintetizado pela `moxcms`, para o documento seguir o mesmo caminho
//! das imagens com perfil embutido. PQ e HLG são levados a SDR (ver `hdr`), nas mesmas primárias.
//! As curvas do BT.709/BT.601 (1 e 6) valem como a do sRGB, como nos navegadores e como o app
//! sempre fez; a do BT.2020 (14 e 15) é a do perfil "Rec. ITU-R BT.2020" já oferecido pelo app.
use super::{hdr, icc};
use moxcms::{
    Chromaticity, CicpColorPrimaries, CicpProfile, ColorPrimaries, ColorProfile as Icc,
    LocalizableString, MatrixCoefficients, ProfileText, ToneReprCurve, TransferCharacteristics,
};
use std::panic::{UnwindSafe, catch_unwind};

const P_BT709: u8 = 1;
const P_BT2020: u8 = 9;
const P_DISPLAY_P3: u8 = 12;
const T_SRGB: u8 = 13;

/// Como interpretar os pixels de um arquivo que declara a própria cor.
#[derive(Debug, Clone, PartialEq)]
pub enum Color {
    /// sRGB: nada a converter.
    Srgb,
    Icc(Vec<u8>),
    /// Alcance estendido: os pixels passam por `hdr::to_sdr` e ficam no perfil (`None` = sRGB).
    Hdr(hdr::Transfer, Option<Vec<u8>>),
}

impl Color {
    pub fn icc(self) -> Option<Vec<u8>> {
        match self {
            Color::Srgb => None,
            Color::Icc(b) => Some(b),
            Color::Hdr(_, b) => b,
        }
    }
}

/// Cor dos pontos de código do ITU-T H.273 (a matriz já foi desfeita). `None` = não especificada
/// ou desconhecida.
pub fn from_code_points(primaries: u8, transfer: u8) -> Option<Color> {
    let hdr = match transfer {
        16 => Some(hdr::Transfer::Pq),
        18 => Some(hdr::Transfer::Hlg),
        _ => None,
    };
    let curve = match transfer {
        // 2 = não especificada: as primárias valem com a curva do sRGB.
        1 | 2 | 6 | 16 | 18 => T_SRGB,
        t => t,
    };
    let profile = match (primaries, curve) {
        (P_BT709, T_SRGB) => None,
        (P_DISPLAY_P3, T_SRGB) => Some(icc::known_profile("display-p3")?.to_vec()),
        (P_BT2020, 14 | 15) => Some(icc::known_profile("rec2020")?.to_vec()),
        (p, t) => Some(profile_of(p, t)?),
    };
    Some(match (hdr, profile) {
        (Some(t), icc) => Color::Hdr(t, icc),
        (None, Some(b)) => Color::Icc(b),
        (None, None) => Color::Srgb,
    })
}

fn profile_of(primaries: u8, transfer: u8) -> Option<Vec<u8>> {
    let cicp = CicpProfile {
        color_primaries: CicpColorPrimaries::try_from(primaries).ok()?,
        transfer_characteristics: TransferCharacteristics::try_from(transfer).ok()?,
        matrix_coefficients: MatrixCoefficients::Identity,
        full_range: true,
    };
    let name = match primaries {
        P_BT709 => "Rec. ITU-R BT.709".into(),
        4 => "BT.470 M".into(),
        5 => "BT.601 625".into(),
        6 | 7 => "BT.601 525".into(),
        P_BT2020 => "Rec. ITU-R BT.2020".into(),
        11 => "DCI-P3".into(),
        P_DISPLAY_P3 => "Display P3".into(),
        p => format!("CICP {p}/{transfer}"),
    };
    // `new_from_cicp` deixa o perfil pela metade quando não conhece as primárias ou a curva.
    let build = || Some(Icc::new_from_cicp(cicp)).filter(|p| p.red_trc.is_some());
    finish(build, &name)
}

/// Serializa o perfil com nome; `None` se a `moxcms` não conseguir convertê-lo para o sRGB.
fn finish(build: impl FnOnce() -> Option<Icc> + UnwindSafe, name: &str) -> Option<Vec<u8>> {
    let text = |s: &str| {
        let s = LocalizableString::new("en".into(), "US".into(), s.into());
        Some(ProfileText::Localizable(vec![s]))
    };
    let bytes = catch_unwind(|| {
        let mut p = build()?;
        p.description = text(name);
        p.copyright = text("Public Domain");
        p.cicp = None;
        p.encode().ok()
    })
    .ok()??;
    icc::convertible(&bytes, icc::srgb_icc()).then_some(bytes)
}

/// Coordenadas xy do sRGB: vermelho, verde, azul e branco D65.
const SRGB_XY: [(f32, f32); 4] = [(0.64, 0.33), (0.30, 0.60), (0.15, 0.06), (0.3127, 0.3290)];
/// Diferença que o arredondamento dos programas que gravam `cHRM` produz.
const XY_TOLERANCE: f32 = 0.003;

/// Perfil com primárias, branco e gama próprios (`None` = curva do sRGB). `None` quando é o
/// próprio sRGB ou quando os valores não descrevem um espaço de cor.
pub fn icc_from_primaries(
    rgb: [(f32, f32); 3],
    white: (f32, f32),
    gamma: Option<f32>,
) -> Option<Vec<u8>> {
    let all = [rgb[0], rgb[1], rgb[2], white];
    let absurd = |(x, y): &(f32, f32)| {
        !x.is_finite() || !y.is_finite() || x.abs() > 2.0 || y.abs() > 2.0 || y.abs() < 1e-4
    };
    // Triângulo sem área (primárias alinhadas) não tem inversa.
    let side = |a: usize| (rgb[a].0 - rgb[0].0, rgb[a].1 - rgb[0].1);
    let (g, b) = (side(1), side(2));
    if all.iter().any(absurd) || (g.0 * b.1 - b.0 * g.1).abs() < 1e-3 {
        return None;
    }
    let near = |a: f32, b: f32| (a - b).abs() <= XY_TOLERANCE;
    let srgb = all.iter().zip(SRGB_XY).all(|(a, b)| near(a.0, b.0) && near(a.1, b.1));
    if srgb && gamma.is_none() {
        return None;
    }
    let xy = |p: (f32, f32)| Chromaticity::new(p.0, p.1);
    let build = move || {
        let mut p = Icc::new_srgb();
        if !srgb {
            let primaries = ColorPrimaries {
                red: xy(rgb[0]),
                green: xy(rgb[1]),
                blue: xy(rgb[2]),
            };
            p.update_rgb_colorimetry(xy(white).to_xyyb(), primaries);
            p.media_white_point = None;
        }
        if let Some(g) = gamma {
            let curve = ToneReprCurve::Parametric(vec![g]);
            p.red_trc = Some(curve.clone());
            p.green_trc = Some(curve.clone());
            p.blue_trc = Some(curve);
        }
        Some(p)
    };
    finish(build, &gamma.map_or("RGB".into(), |g| format!("RGB, γ {g:.2}")))
}

// ---------- PNG ----------

/// Cor declarada pelos blocos do PNG antes do primeiro `IDAT`; `None` = vale o `iCCP`, que o
/// decodificador já lê. Blocos de CRC errado são ignorados; de um repetido vale o primeiro.
/// A primeira caixa `colr` do tipo `nclx` de um HEIF/AVIF declara PQ ou HLG? Só para estimar
/// memória: quem decide a cor é o decodificador.
pub fn isobmff_is_hdr(bytes: &[u8]) -> bool {
    bytes.windows(8).position(|w| w == b"colrnclx").is_some_and(|at| {
        bytes.get(at + 10..at + 12).is_some_and(|t| matches!(u16::from_be_bytes([t[0], t[1]]), 16 | 18))
    })
}

pub fn png_color(bytes: &[u8]) -> Option<Color> {
    let (mut cicp, mut iccp, mut srgb, mut gama, mut chrm) = (None, false, false, None, None);
    let mut rest = bytes.get(8..).unwrap_or_default();
    while let Some(len) = be32(rest) {
        let len = len as usize;
        let Some(body) = len.checked_add(8).and_then(|end| rest.get(4..end)) else {
            break;
        };
        let (kind, data) = body.split_at(4);
        let Some(crc) = be32(&rest[len + 8..]) else {
            break;
        };
        match kind {
            b"IDAT" | b"IEND" => break,
            b"cICP" | b"iCCP" | b"sRGB" | b"gAMA" | b"cHRM" if crc32fast::hash(body) == crc => {
                match (kind, data) {
                    // Matriz 0 (RGB) e faixa completa são as únicas que o app lê.
                    (b"cICP", &[p, t, 0, 1]) if cicp.is_none() => cicp = from_code_points(p, t),
                    (b"iCCP", _) => iccp = true,
                    (b"sRGB", &[_]) => srgb = true,
                    (b"gAMA", d) if d.len() == 4 => gama = gama.or_else(|| be32(d)),
                    (b"cHRM", d) if d.len() == 32 => chrm = chrm.or(Some(d)),
                    _ => {}
                }
            }
            _ => {}
        }
        rest = &rest[len + 12..];
    }
    match cicp {
        Some(c) => Some(c),
        None if iccp => None,
        None if srgb => Some(Color::Srgb),
        None => Some(calibrated(gama, chrm).map_or(Color::Srgb, Color::Icc)),
    }
}

fn be32(b: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(*b.first_chunk()?))
}

/// `gAMA` (100000/γ) e `cHRM` (branco, vermelho, verde, azul). O 45455 do `gAMA` é a aproximação
/// do sRGB que quase todo programa grava: vale a curva do sRGB, como na libpng.
fn calibrated(gama: Option<u32>, chrm: Option<&[u8]>) -> Option<Vec<u8>> {
    let gamma = gama
        .filter(|g| (10_000..=500_000).contains(g) && g.abs_diff(45_455) > 500)
        .map(|g| 1e5 / g as f32);
    let declared = chrm.and_then(|d| {
        let xy = |i: usize| Some((be32(&d[i * 8..])? as f32 / 1e5, be32(&d[i * 8 + 4..])? as f32 / 1e5));
        icc_from_primaries([xy(1)?, xy(2)?, xy(3)?], xy(0)?, gamma)
    });
    // Primárias ausentes, do sRGB ou sem sentido: o `gAMA` ainda vale.
    declared.or_else(|| icc_from_primaries([SRGB_XY[0], SRGB_XY[1], SRGB_XY[2]], SRGB_XY[3], gamma))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pontos_de_codigo_conhecidos() {
        assert_eq!(from_code_points(1, 13), Some(Color::Srgb));
        assert_eq!(from_code_points(1, 1), Some(Color::Srgb), "BT.709 como sRGB");
        assert_eq!(from_code_points(2, 2), None, "não especificado");
        assert_eq!(from_code_points(200, 13), None, "reservado");
        assert_eq!(from_code_points(1, 200), None);
        let p3 = icc::known_profile("display-p3").unwrap().to_vec();
        assert_eq!(from_code_points(12, 13), Some(Color::Icc(p3.clone())));
        assert_eq!(from_code_points(12, 16), Some(Color::Hdr(hdr::Transfer::Pq, Some(p3))));
        assert_eq!(from_code_points(1, 18), Some(Color::Hdr(hdr::Transfer::Hlg, None)));
    }

    #[test]
    fn nenhum_ponto_de_codigo_derruba_o_app() {
        for p in 0..=255u8 {
            for t in [0, 1, 2, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 255] {
                if let Some(b) = from_code_points(p, t).and_then(Color::icc) {
                    assert!(icc::is_rgb_profile(&b), "{p}/{t}");
                }
            }
        }
    }

    #[test]
    fn primarias_sem_sentido_sao_recusadas() {
        let w = (0.3127, 0.3290);
        let p3 = [(0.68, 0.32), (0.265, 0.69), (0.15, 0.06)];
        assert!(icc_from_primaries(p3, w, None).is_some());
        for (rgb, white) in [
            ([(0.3, 0.3); 3], w),
            ([(0.0, 0.1), (0.5, 0.6), (0.9, 1.0)], w),
            (p3, (0.3, 0.0)),
            ([(f32::NAN, 0.3), p3[1], p3[2]], w),
            ([(1e9, 0.3), p3[1], p3[2]], w),
            ([(0.6, 0.0), p3[1], p3[2]], w),
        ] {
            assert_eq!(icc_from_primaries(rgb, white, None), None, "{rgb:?} {white:?}");
        }
        let srgb = [SRGB_XY[0], SRGB_XY[1], SRGB_XY[2]];
        assert_eq!(icc_from_primaries(srgb, w, None), None, "o próprio sRGB");
    }
}
