//! JPEG 2000 (contêiner JP2) com o `openjp2`, porta em Rust puro do OpenJPEG: nada de
//! libopenjp2 no NEEDED. Leva o perfil ICC (caixa `colr`); o JP2 não tem lugar padrão
//! para EXIF, que fica de fora.
use super::encode::MetaCarry;
use crate::error::{AppError, AppResult};
use ::image::DynamicImage;
use openjp2::{EncodeParameters, Image};

/// Níveis de resolução do OpenJPEG (padrão 6), limitados pelo lado menor: cada nível
/// divide a imagem por 2 e o menor precisa ter ao menos 1 pixel.
const MAX_RESOLUTIONS: u32 = 6;

/// Taxa de compressão (N:1) para a qualidade 1..=100: 90 → 6:1, 50 → 26:1, 1 → 50:1.
fn rate(q: u8) -> f32 {
    1.0 + (100 - q.clamp(1, 100)) as f32 * 0.5
}

/// `None`: sem perdas (transformada reversível 5-3). `Some(q)`: 9-7 com taxa pela qualidade.
pub fn encode(pixels: &DynamicImage, quality: Option<u8>, meta: &MetaCarry) -> AppResult<Vec<u8>> {
    let side = pixels.width().min(pixels.height());
    let mut core = Image::from_dynamic_image(pixels).into_core_image();
    if let Some(icc) = &meta.icc {
        core.icc_profile_buf = icc.clone();
    }
    let mut params =
        EncodeParameters::new().num_resolutions(side.ilog2().min(MAX_RESOLUTIONS - 1) + 1);
    if let Some(q) = quality {
        params = params.irreversible(true).layer_rate(rate(q));
    }
    Image::from_core_image(core)
        .encode_jp2(params)
        .map_err(|e| AppError::Io(format!("falha ao codificar: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{decode::decode_bytes, test_util::*};
    use std::path::Path;

    fn reabre(bytes: &[u8]) -> crate::image::decode::Decoded {
        decode_bytes(Path::new("x.jp2"), bytes).unwrap()
    }

    #[test]
    fn sem_perdas_volta_identico() {
        let img = gradiente(65, 47);
        let out = encode(
            &DynamicImage::ImageRgb8(img.clone()),
            None,
            &MetaCarry::default(),
        )
        .unwrap();
        assert!(
            out.starts_with(b"\0\0\0\x0cjP  \r\n\x87\n"),
            "assinatura JP2"
        );
        let d = reabre(&out);
        assert_eq!(d.frames[0], DynamicImage::ImageRgb8(img).to_rgba8());
    }

    #[test]
    fn com_perdas_menor_e_parecido() {
        let px = DynamicImage::ImageRgb8(foto(200, 150));
        let lossless = encode(&px, None, &MetaCarry::default()).unwrap();
        let alta = encode(&px, Some(90), &MetaCarry::default()).unwrap();
        let baixa = encode(&px, Some(20), &MetaCarry::default()).unwrap();
        assert!(
            baixa.len() < alta.len() && alta.len() < lossless.len(),
            "{} {} {}",
            baixa.len(),
            alta.len(),
            lossless.len()
        );
        let d = reabre(&alta);
        assert_eq!(d.frames[0].dimensions(), (200, 150));
        let p = psnr(&px.to_rgba8(), &d.frames[0]);
        assert!(p > 30.0, "PSNR {p}");
    }

    #[test]
    fn alfa_e_icc_sobrevivem() {
        let img = ::image::RgbaImage::from_fn(9, 7, |x, y| {
            ::image::Rgba([x as u8 * 20, y as u8 * 30, 7, (x * 25) as u8])
        });
        let meta = MetaCarry {
            icc: Some(icc_falso()),
            ..MetaCarry::default()
        };
        let out = encode(&DynamicImage::ImageRgba8(img.clone()), None, &meta).unwrap();
        let d = reabre(&out);
        assert_eq!(d.frames[0], img);
        assert_eq!(d.icc, meta.icc);
    }

    #[test]
    fn imagem_de_1_pixel() {
        let img = ::image::RgbImage::from_pixel(1, 1, ::image::Rgb([10, 20, 30]));
        let out = encode(
            &DynamicImage::ImageRgb8(img),
            Some(50),
            &MetaCarry::default(),
        )
        .unwrap();
        assert_eq!(reabre(&out).frames[0].dimensions(), (1, 1));
    }

    #[test]
    fn lixo_vira_corrupt() {
        let e = decode_bytes(Path::new("x.jp2"), b"\0\0\0\x0cjP  \r\n\x87\nlixo").unwrap_err();
        assert_eq!(e.code(), "corrupt");
    }
}
