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

/// Pasta temporária própria do processo, criada se faltar.
pub fn tmp(nome: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("gvi-{nome}-{}", std::process::id()));
    fs::create_dir_all(&d).unwrap();
    d
}

pub fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Grava `img` como PNG RGBA com compressão rápida.
pub fn png(path: &Path, img: &RgbaImage) {
    let f = std::io::BufWriter::new(fs::File::create(path).unwrap());
    image::codecs::png::PngEncoder::new_with_quality(
        f,
        image::codecs::png::CompressionType::Fast,
        Default::default(),
    )
    .write_image(
        img.as_raw(),
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgba8,
    )
    .unwrap();
}

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

/// Constrói um bloco TIFF (little-endian) com Make/Model e GPS conhecidos.
/// Lat 48°51'30" N, Lon 122°25'10" W, altitude 15,5 m acima do nível do mar.
pub fn exif_tiff_gps() -> Vec<u8> {
    fn entry(tag: u16, ty: u16, count: u32, val: [u8; 4]) -> Vec<u8> {
        let mut e = tag.to_le_bytes().to_vec();
        e.extend_from_slice(&ty.to_le_bytes());
        e.extend_from_slice(&count.to_le_bytes());
        e.extend_from_slice(&val);
        e
    }
    fn rationals(v: &[(u32, u32)]) -> Vec<u8> {
        v.iter()
            .flat_map(|(n, d)| [n.to_le_bytes(), d.to_le_bytes()].concat())
            .collect()
    }
    let make = b"Gera\0";
    let model = b"TestCam\0";
    // Layout: cabeçalho (8) + IFD0 (2 + 3*12 + 4 = 42) + dados + IFD GPS.
    let off_make = 50u32;
    let off_model = off_make + make.len() as u32;
    let off_gps = (off_model + model.len() as u32).next_multiple_of(2);
    let gps_len = 2 + 6 * 12 + 4;
    let off_lat = off_gps + gps_len;
    let off_lon = off_lat + 24;
    let off_alt = off_lon + 24;

    let mut t = b"II*\0".to_vec();
    t.extend_from_slice(&8u32.to_le_bytes());
    t.extend_from_slice(&3u16.to_le_bytes());
    t.extend(entry(0x010F, 2, make.len() as u32, off_make.to_le_bytes()));
    t.extend(entry(
        0x0110,
        2,
        model.len() as u32,
        off_model.to_le_bytes(),
    ));
    t.extend(entry(0x8825, 4, 1, off_gps.to_le_bytes()));
    t.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(t.len() as u32, off_make);
    t.extend_from_slice(make);
    t.extend_from_slice(model);
    while (t.len() as u32) < off_gps {
        t.push(0);
    }
    t.extend_from_slice(&6u16.to_le_bytes());
    t.extend(entry(1, 2, 2, [b'N', 0, 0, 0]));
    t.extend(entry(2, 5, 3, off_lat.to_le_bytes()));
    t.extend(entry(3, 2, 2, [b'W', 0, 0, 0]));
    t.extend(entry(4, 5, 3, off_lon.to_le_bytes()));
    t.extend(entry(5, 1, 1, [0, 0, 0, 0]));
    t.extend(entry(6, 5, 1, off_alt.to_le_bytes()));
    t.extend_from_slice(&0u32.to_le_bytes());
    t.extend(rationals(&[(48, 1), (51, 1), (30, 1)]));
    t.extend(rationals(&[(122, 1), (25, 1), (10, 1)]));
    t.extend(rationals(&[(155, 10)]));
    t
}

fn jpeg_with_segment(img: &RgbImage, marker: u8, payload: &[u8]) -> Vec<u8> {
    let jpg = jpeg_bytes(img, 90);
    let mut out = jpg[..2].to_vec();
    out.extend_from_slice(&[0xFF, marker]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&jpg[2..]);
    out
}

/// JPEG com Make/Model/GPS conhecidos (ver `exif_tiff_gps`).
pub fn jpeg_with_gps() -> Vec<u8> {
    let payload = [b"Exif\0\0".as_slice(), &exif_tiff_gps()].concat();
    jpeg_with_segment(&gradient(32, 24), 0xE1, &payload)
}

/// Perfil ICC mínimo (v2) cuja tag `desc` é `name`.
pub fn icc_profile_named(name: &str) -> Vec<u8> {
    let mut desc = b"desc\0\0\0\0".to_vec();
    desc.extend_from_slice(&(name.len() as u32 + 1).to_be_bytes());
    desc.extend_from_slice(name.as_bytes());
    desc.push(0);
    let tag_off = 128u32 + 4 + 12;
    let total = tag_off + desc.len() as u32;
    let mut p = vec![0u8; 128];
    p[0..4].copy_from_slice(&total.to_be_bytes());
    p[8] = 2; // versão 2
    p[12..16].copy_from_slice(b"mntr");
    p[16..20].copy_from_slice(b"RGB ");
    p[20..24].copy_from_slice(b"XYZ ");
    p[36..40].copy_from_slice(b"acsp");
    p.extend_from_slice(&1u32.to_be_bytes());
    p.extend_from_slice(b"desc");
    p.extend_from_slice(&tag_off.to_be_bytes());
    p.extend_from_slice(&(desc.len() as u32).to_be_bytes());
    p.extend_from_slice(&desc);
    p
}

/// JPEG com o perfil sRGB embutido (APP2 `ICC_PROFILE`).
pub fn jpeg_with_srgb() -> Vec<u8> {
    let mut payload = b"ICC_PROFILE\0\x01\x01".to_vec();
    payload.extend(icc_profile_named("sRGB IEC61966-2.1"));
    jpeg_with_segment(&gradient(32, 24), 0xE2, &payload)
}

/// JPEG com IPTC (APP13): título, copyright e duas palavras-chave.
pub fn jpeg_with_iptc() -> Vec<u8> {
    fn ds(rec: u8, num: u8, v: &str) -> Vec<u8> {
        let mut d = vec![0x1C, rec, num];
        d.extend_from_slice(&(v.len() as u16).to_be_bytes());
        d.extend_from_slice(v.as_bytes());
        d
    }
    let mut iptc = ds(2, 5, "Praia");
    iptc.extend(ds(2, 116, "Gera"));
    iptc.extend(ds(2, 25, "mar"));
    iptc.extend(ds(2, 25, "sol"));
    let mut p = b"Photoshop 3.0\0".to_vec();
    p.extend_from_slice(b"8BIM");
    p.extend_from_slice(&0x0404u16.to_be_bytes());
    p.extend_from_slice(&[0, 0]); // nome pascal vazio, preenchido para par
    p.extend_from_slice(&(iptc.len() as u32).to_be_bytes());
    p.extend_from_slice(&iptc);
    if iptc.len() % 2 == 1 {
        p.push(0);
    }
    jpeg_with_segment(&gradient(32, 24), 0xED, &p)
}

/// JPEG CMYK (Adobe, YCCK) 24x16, sem perfil. Gerado uma vez pelo ImageMagick
/// (`magick -size 24x16 gradient:red-blue -colorspace CMYK -quality 90 -strip`): nem a crate
/// `image` nem o `jpeg-decoder` gravam CMYK.
pub fn jpeg_cmyk() -> Vec<u8> {
    const HEX: &[&str] = &[
        "ffd8ffee000e41646f626500640000000002ffdb0043000302020302020303030304030304050805050404050a070706",
        "080c0a0c0c0b0a0b0b0d0e12100d0e110e0b0b1016101113141515150c0f171816141812141514ffdb00430103040405",
        "040509050509140d0b0d1414141414141414141414141414141414141414141414141414141414141414141414141414",
        "141414141414141414141414ffc00014080010001804011100021101031101041100ffc4001600010101000000000000",
        "00000000000000000708ffc4001f10000102060300000000000000000000000002180104161764a2525491ffc4001701",
        "0101010100000000000000000000000000090308ffc4001d110001030501000000000000000000000000010417021451",
        "539115ffda000e040100021103110400003f00b5d428e703091daec4e92fecd706b473997b0a851ce02476bb13a2cd70",
        "1ce65ec2a14738091daec4e8b35c073997b151b532bd74f84dbf62bc9dfb1c35d69c0d8f13516a657ae9f07b15e4470d",
        "75a70363c4d45a995eba7c1ec57911c35d69c0d8f1353fffd9",
    ];
    let hex = HEX.concat();
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
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
    write_if_missing(&p("meta_gps.jpg"), jpeg_with_gps);
    write_if_missing(&p("meta_srgb.jpg"), jpeg_with_srgb);
    write_if_missing(&p("meta_iptc.jpg"), jpeg_with_iptc);
    write_if_missing(&p("cmyk.jpg"), jpeg_cmyk);
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
    write_if_missing(&p("img.dng"), || dng_linear(64, 48, false, false));
    write_if_missing(&p("img_previa.dng"), || dng_linear(64, 48, true, false));

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

/// DNG com IFD0 = miniatura e o sensor num SubIFD, como as câmeras gravam
/// (gerado em memória: não vai para `fixtures/`).
pub fn dng_sensor_em_subifd(w: usize, h: usize) -> Vec<u8> {
    dng_linear(w, h, false, true)
}

/// DNG "LinearRaw" (RGB já demosaicado) escrito pelo próprio `rawler`, opcionalmente
/// com prévia JPEG embutida (subframe 1) e com o sensor num SubIFD (IFD0 = miniatura).
fn dng_linear(w: usize, h: usize, preview: bool, sensor_em_subifd: bool) -> Vec<u8> {
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
        if sensor_em_subifd {
            dng.thumbnail(&image::DynamicImage::ImageRgb8(gradient(64, 48)))
                .unwrap();
        }
        let mut sub = if sensor_em_subifd {
            dng.subframe(0)
        } else {
            dng.subframe_on_root(0)
        };
        // Sensor em SubIFD comprimido (como nas câmeras): o arquivo fica bem menor que o sensor.
        let compression = if sensor_em_subifd {
            DngCompression::Lossless
        } else {
            DngCompression::Uncompressed
        };
        sub.rgb_image_u8(img.as_raw(), w, h, compression, 1)
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
