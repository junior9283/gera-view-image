//! Gera as fixtures de `tests/fixtures/` (só as que faltam; apague a pasta para regenerar).
//! Também é incluído por `core.rs` via `#[path]`, para os testes não dependerem da ordem.
#![allow(dead_code)]

use image::{ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Once,
};

pub const DIR_ACENTOS: &str = "Ação com espaço";

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Garante que todas as fixtures existem e devolve a pasta.
pub fn ensure_fixtures() -> PathBuf {
    static ONCE: Once = Once::new();
    let dir = fixtures_dir();
    ONCE.call_once(|| generate(&dir));
    dir
}

fn gradient(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        Rgb([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, 128])
    })
}

fn gradient_rgba(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        Rgba([
            (x * 255 / w) as u8,
            (y * 255 / h) as u8,
            200,
            ((x + y) * 255 / (w + h)) as u8,
        ])
    })
}

pub fn jpeg_bytes(img: &RgbImage, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    out
}

/// Bloco APP1 Exif mínimo (TIFF little-endian, IFD0 só com `Orientation`).
pub fn exif_app1_orientation(orientation: u16) -> Vec<u8> {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&8u32.to_le_bytes());
    tiff.extend_from_slice(&1u16.to_le_bytes()); // 1 entrada
    tiff.extend_from_slice(&0x0112u16.to_le_bytes());
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes()); // próximo IFD
    let mut seg = vec![0xFF, 0xE1];
    seg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
    seg.extend_from_slice(b"Exif\0\0");
    seg.extend_from_slice(&tiff);
    seg
}

/// JPEG com EXIF `Orientation` inserido logo depois do SOI.
pub fn jpeg_with_orientation(img: &RgbImage, orientation: u16) -> Vec<u8> {
    let jpg = jpeg_bytes(img, 90);
    let mut out = jpg[..2].to_vec();
    out.extend_from_slice(&exif_app1_orientation(orientation));
    out.extend_from_slice(&jpg[2..]);
    out
}

fn save_png(img: &RgbaImage, path: &Path) {
    img.save_with_format(path, image::ImageFormat::Png).unwrap();
}

fn write_if_missing(path: &Path, make: impl FnOnce() -> Vec<u8>) {
    if !path.exists() {
        fs::write(path, make()).unwrap();
    }
}

fn generate(dir: &Path) {
    fs::create_dir_all(dir.join(DIR_ACENTOS)).unwrap();
    let p = |n: &str| dir.join(n);

    write_if_missing(&p("rgb.jpg"), || {
        jpeg_with_orientation(&gradient(40, 20), 6)
    });
    if !p("alpha.png").exists() {
        save_png(&gradient_rgba(30, 30), &p("alpha.png"));
    }
    write_if_missing(&p("anim.gif"), gif_3_frames);
    write_if_missing(&p("multi.tiff"), tiff_2_pages);
    write_if_missing(&p("img.webp"), || {
        let img = gradient_rgba(24, 16);
        let mut out = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .write_image(img.as_raw(), 24, 16, image::ExtendedColorType::Rgba8)
            .unwrap();
        out
    });
    write_if_missing(&p("img.avif"), || {
        heif_bytes(libheif_rs::CompressionFormat::Av1)
    });
    write_if_missing(&p("img.heic"), || {
        heif_bytes(libheif_rs::CompressionFormat::Hevc)
    });
    for (name, fmt, w, h) in [
        ("img.bmp", image::ImageFormat::Bmp, 20, 10),
        ("img.ico", image::ImageFormat::Ico, 32, 32),
        ("img.tga", image::ImageFormat::Tga, 20, 10),
    ] {
        write_if_missing(&p(name), || {
            let mut c = Cursor::new(Vec::new());
            gradient_rgba(w, h).write_to(&mut c, fmt).unwrap();
            c.into_inner()
        });
    }
    write_if_missing(&p("img.svg"), || {
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50" fill="#3b82f6"/><circle cx="50" cy="25" r="20" fill="#fff"/></svg>"##.to_vec()
    });
    write_if_missing(&p("truncado.jpg"), || {
        jpeg_bytes(&gradient(200, 200), 90)[..500].to_vec()
    });
    write_if_missing(&p("texto.png"), || {
        "isto não é uma imagem\n".as_bytes().to_vec()
    });
    write_if_missing(&p("img.psd"), || psd_rgb(40, 30));
    write_if_missing(&p("img.dng"), || dng_linear(64, 48, false));
    write_if_missing(&p("img_previa.dng"), || dng_linear(64, 48, true));

    let acc = dir.join(DIR_ACENTOS);
    for n in ["img2.png", "img10.png"] {
        if !acc.join(n).exists() {
            save_png(&gradient_rgba(12, 8), &acc.join(n));
        }
    }
    write_if_missing(&acc.join("Ação 1.jpg"), || {
        jpeg_bytes(&gradient(16, 12), 85)
    });
    write_if_missing(&acc.join("notas.txt"), || b"nao e imagem".to_vec());
}

fn gif_3_frames() -> Vec<u8> {
    use image::{Delay, Frame, codecs::gif::GifEncoder};
    let mut out = Vec::new();
    {
        let mut enc = GifEncoder::new(&mut out);
        enc.set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for (i, ms) in [100u32, 200, 300].into_iter().enumerate() {
            let img = RgbaImage::from_pixel(16, 16, Rgba([(i * 100) as u8, 50, 50, 255]));
            enc.encode_frame(Frame::from_parts(
                img,
                0,
                0,
                Delay::from_numer_denom_ms(ms, 1),
            ))
            .unwrap();
        }
    }
    out
}

fn tiff_2_pages() -> Vec<u8> {
    use tiff::encoder::{TiffEncoder, colortype};
    let mut c = Cursor::new(Vec::new());
    {
        let mut enc = TiffEncoder::new(&mut c).unwrap();
        let a = gradient(32, 24);
        enc.write_image::<colortype::RGB8>(32, 24, a.as_raw())
            .unwrap();
        let b = gradient(16, 16);
        enc.write_image::<colortype::RGB8>(16, 16, b.as_raw())
            .unwrap();
    }
    c.into_inner()
}

/// HEIC (x265) ou AVIF (aom) 64x48 pelo libheif do sistema.
fn heif_bytes(format: libheif_rs::CompressionFormat) -> Vec<u8> {
    use libheif_rs::{Channel, ColorSpace, EncoderQuality, HeifContext, Image, LibHeif, RgbChroma};
    let (w, h) = (64u32, 48u32);
    let mut img = Image::new(w, h, ColorSpace::Rgb(RgbChroma::Rgb)).unwrap();
    img.create_plane(Channel::Interleaved, w, h, 8).unwrap();
    let planes = img.planes_mut();
    let plane = planes.interleaved.unwrap();
    let src = gradient(w, h);
    for y in 0..h as usize {
        let row = &src.as_raw()[y * w as usize * 3..(y + 1) * w as usize * 3];
        plane.data[y * plane.stride..y * plane.stride + row.len()].copy_from_slice(row);
    }
    let lib = LibHeif::new();
    let mut ctx = HeifContext::new().unwrap();
    let mut enc = lib
        .encoder_for_format(format)
        .expect("encoder do libheif ausente");
    enc.set_quality(EncoderQuality::Lossy(80)).unwrap();
    ctx.encode_image(&img, &mut enc, None).unwrap();
    ctx.write_to_bytes().unwrap()
}

/// PSD RGB 8 bits mínimo (sem camadas, dados crus planares).
pub fn psd_rgb(w: u32, h: u32) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"8BPS");
    b.extend_from_slice(&1u16.to_be_bytes());
    b.extend_from_slice(&[0; 6]);
    b.extend_from_slice(&3u16.to_be_bytes()); // canais
    b.extend_from_slice(&h.to_be_bytes());
    b.extend_from_slice(&w.to_be_bytes());
    b.extend_from_slice(&8u16.to_be_bytes()); // profundidade
    b.extend_from_slice(&3u16.to_be_bytes()); // RGB
    b.extend_from_slice(&0u32.to_be_bytes()); // color mode data
    b.extend_from_slice(&0u32.to_be_bytes()); // image resources
    b.extend_from_slice(&0u32.to_be_bytes()); // layer and mask info
    b.extend_from_slice(&0u16.to_be_bytes()); // compressão: crua
    let img = gradient(w, h);
    for c in 0..3 {
        b.extend(img.pixels().map(|p| p.0[c]));
    }
    b
}

/// DNG "LinearRaw" (RGB já demosaicado) escrito pelo próprio `rawler`,
/// opcionalmente com prévia JPEG embutida (subframe 1), como as câmeras gravam.
fn dng_linear(w: usize, h: usize, preview: bool) -> Vec<u8> {
    use rawler::{
        dng::{DngCompression, writer::DngWriter},
        formats::tiff::{Rational, SRational},
        imgop::xyz::Illuminant,
        tags::{DngTag, TiffCommonTag},
    };
    let img = gradient(w as u32, h as u32);
    let mut c = Cursor::new(Vec::new());
    {
        let mut dng = DngWriter::new(&mut c, [1, 4, 0, 0]).unwrap();
        dng.root_ifd_mut().add_tag(TiffCommonTag::Make, "Gera");
        dng.root_ifd_mut().add_tag(TiffCommonTag::Model, "Fixture");
        dng.root_ifd_mut()
            .add_tag(DngTag::UniqueCameraModel, "Gera Fixture");
        let one = SRational::new(1, 1);
        let zero = SRational::new(0, 1);
        dng.color_matrix(
            1,
            Illuminant::D65,
            [one, zero, zero, zero, one, zero, zero, zero, one],
        );
        dng.as_shot_neutral([
            Rational::new(1, 1),
            Rational::new(1, 1),
            Rational::new(1, 1),
        ]);
        let mut sub = dng.subframe_on_root(0);
        sub.rgb_image_u8(img.as_raw(), w, h, DngCompression::Uncompressed, 0)
            .unwrap();
        sub.finalize().unwrap();
        if preview {
            let small = image::DynamicImage::ImageRgb8(gradient(w as u32 / 2, h as u32 / 2));
            let mut sub = dng.subframe(1);
            sub.preview(&small, 0.8).unwrap();
            sub.finalize().unwrap();
        }
        dng.close().unwrap();
    }
    c.into_inner()
}

#[test]
fn gera_fixtures() {
    let dir = ensure_fixtures();
    assert!(dir.join("rgb.jpg").exists());
    assert!(dir.join(DIR_ACENTOS).join("img10.png").exists());
}
