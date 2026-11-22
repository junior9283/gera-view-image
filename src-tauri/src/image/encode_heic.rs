//! Gravar HEIC: libheif embutida com o plugin kvazaar (HEVC). A libkvazaar é OPCIONAL e
//! carregada com `dlopen` (`native/heic/kvazaar_dl.cc`), como a libde265 em `heic.rs`: sem
//! ela, `hevc_encoder_available()` é falso, o Exportar oculta HEIC e o Salvar leva ao
//! Exportar. Leva EXIF e perfil ICC.
use super::encode::MetaCarry;
use crate::error::{AppError, AppResult};
use ::image::DynamicImage;
use libheif_rs::{
    Channel, ColorProfileRaw, ColorSpace, CompressionFormat, EncoderQuality, HeifContext, Image,
    LibHeif, RgbChroma, color_profile_types,
};
use std::{
    ffi::{CStr, c_char, c_int},
    sync::OnceLock,
};

pub const DEFAULT_QUALITY: u8 = 80;

unsafe extern "C" {
    fn gvi_kvazaar_load(soname: *const c_char) -> c_int;
    fn gvi_kvazaar_plugin() -> *const libheif_sys::heif_encoder_plugin;
}

/// Troca a biblioteca procurada (usado pelo teste "libkvazaar ausente"). Lida só na primeira
/// consulta do processo; aceita só um nome, nunca um caminho.
pub const SONAME_ENV: &str = "GVI_LIBKVAZAAR_SONAME";
const DEFAULT_SONAME: &CStr = c"libkvazaar.so.7";

/// Carrega a libkvazaar e registra o plugin uma vez por processo.
pub fn hevc_encoder_available() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        let soname = super::heic::soname(std::env::var(SONAME_ENV).ok(), DEFAULT_SONAME);
        // SAFETY: funções C sem pré-condições; o `heif_init` nunca é desfeito (ver `heic.rs`).
        unsafe {
            libheif_sys::heif_init(std::ptr::null_mut());
            gvi_kvazaar_load(soname.as_ptr()) == 1
                && libheif_sys::heif_register_encoder_plugin(gvi_kvazaar_plugin()).code == 0
        }
    })
}

fn heif_err(e: libheif_rs::HeifError) -> AppError {
    AppError::Io(format!("falha ao codificar: {}", e.message))
}

/// `pixels` é RGB8 ou RGBA8 (o alfa vira imagem auxiliar do HEIF).
pub fn encode(pixels: &DynamicImage, quality: Option<u8>, meta: &MetaCarry) -> AppResult<Vec<u8>> {
    if !hevc_encoder_available() {
        return Err(AppError::Unsupported(
            "gravar HEIC precisa da libkvazaar".into(),
        ));
    }
    let (chroma, raw, channels) = match pixels {
        DynamicImage::ImageRgba8(i) => (RgbChroma::Rgba, i.as_raw(), 4),
        DynamicImage::ImageRgb8(i) => (RgbChroma::Rgb, i.as_raw(), 3),
        _ => unreachable!("encode entrega RGB8/RGBA8"),
    };
    let (w, h) = (pixels.width(), pixels.height());
    let mut image = Image::new(w, h, ColorSpace::Rgb(chroma)).map_err(heif_err)?;
    image
        .create_plane(Channel::Interleaved, w, h, 8)
        .map_err(heif_err)?;
    let row = w as usize * channels;
    let plane = image.planes_mut().interleaved.expect("plano criado acima");
    for (dst, src) in plane.data.chunks_mut(plane.stride).zip(raw.chunks(row)) {
        dst[..row].copy_from_slice(src);
    }
    if let Some(icc) = &meta.icc {
        image
            .set_color_profile_raw(&ColorProfileRaw::new(
                color_profile_types::PROF,
                icc.clone(),
            ))
            .map_err(heif_err)?;
    }
    let lib = LibHeif::new();
    let mut encoder = lib
        .encoder_for_format(CompressionFormat::Hevc)
        .map_err(heif_err)?;
    let q = quality.unwrap_or(DEFAULT_QUALITY).clamp(1, 100);
    encoder
        .set_quality(EncoderQuality::Lossy(q))
        .map_err(heif_err)?;
    let mut ctx = HeifContext::new().map_err(heif_err)?;
    let handle = ctx
        .encode_image(&image, &mut encoder, None)
        .map_err(heif_err)?;
    if let Some(exif) = &meta.exif {
        ctx.add_exif_metadata(&handle, exif).map_err(heif_err)?;
    }
    ctx.write_to_bytes().map_err(heif_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{decode::decode_bytes, heic::hevc_available, test_util::*};
    use libheif_rs::HeifContext;
    use std::path::Path;

    /// Dimensões pelo contêiner (não precisa de decodificador HEVC).
    fn dims(bytes: &[u8]) -> (u32, u32) {
        let ctx = HeifContext::read_from_bytes(bytes).unwrap();
        let h = ctx.primary_image_handle().unwrap();
        (h.width(), h.height())
    }

    #[test]
    #[ignore = "precisa da libkvazaar.so.7 (ver docs/testes/armadilhas.md)"]
    fn grava_e_rele_com_psnr_razoavel() {
        // Dimensões ímpares: o plugin estende para 4:2:0 e recorta.
        let img = gradiente(65, 47);
        let px = DynamicImage::ImageRgb8(img);
        let alta = encode(&px, Some(90), &MetaCarry::default()).unwrap();
        let baixa = encode(&px, Some(10), &MetaCarry::default()).unwrap();
        assert_eq!(&alta[4..8], b"ftyp");
        assert_eq!(&alta[8..12], b"heic");
        assert_eq!(dims(&alta), (65, 47));
        assert!(baixa.len() < alta.len());
        if !hevc_available() {
            eprintln!("sem libde265: só o contêiner foi conferido");
            return;
        }
        let d = decode_bytes(Path::new("x.heic"), &alta).unwrap();
        assert_eq!(d.frames[0].dimensions(), (65, 47));
        let p = psnr(&px.to_rgba8(), &d.frames[0]);
        assert!(p > 30.0, "PSNR {p}");
    }

    #[test]
    #[ignore = "precisa da libkvazaar.so.7 (ver docs/testes/armadilhas.md)"]
    fn leva_exif_icc_e_alfa() {
        let tiff = b"II*\0\x08\0\0\0\0\0\0\0\0\0".to_vec();
        let meta = MetaCarry {
            exif: Some(tiff.clone()),
            icc: Some(icc_falso()),
            ..MetaCarry::default()
        };
        let img = ::image::RgbaImage::from_fn(32, 16, |x, _| {
            ::image::Rgba([200, 100, 50, if x < 16 { 0 } else { 255 }])
        });
        let out = encode(&DynamicImage::ImageRgba8(img), None, &meta).unwrap();
        let ctx = HeifContext::read_from_bytes(&out).unwrap();
        let h = ctx.primary_image_handle().unwrap();
        assert!(h.has_alpha_channel());
        assert_eq!(h.color_profile_raw().map(|p| p.data), meta.icc);
        if !hevc_available() {
            return;
        }
        let d = decode_bytes(Path::new("x.heic"), &out).unwrap();
        assert_eq!(d.exif.as_deref(), Some(tiff.as_slice()));
        assert_eq!(d.icc, meta.icc);
        assert!(
            d.frames[0].get_pixel(2, 2)[3] < 30,
            "transparente à esquerda"
        );
        assert!(d.frames[0].get_pixel(29, 2)[3] > 225, "opaco à direita");
    }
}
