//! Formatos só de leitura (OpenEXR, Radiance, PNM, ICNS, JPEG XL, DDS, Farbfeld, codestream JPEG
//! 2000) e cor declarada sem ICC (nclx do HEIF/AVIF, `cICP`/`sRGB`/`gAMA`/`cHRM` do PNG).
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::store::DocStore,
    error::AppError,
    image::{
        decode::{Decoded, MAX_DECODE_BYTES, decode_bytes, detect_format, estimate_bytes, is_supported_path},
        encode::{ExportFormat, ExportOptions, MetaCarry, encode},
        icc,
    },
};
use image::{Rgba, RgbaImage};
use make_fixtures::{s, tmp};
use std::{
    io::Cursor,
    panic::catch_unwind,
    path::{Path, PathBuf},
};

// Bytes de referência: gerados pela libjxl 0.11 (ImageMagick), pelo OpenJPEG 2.5 e pela libaom.
// A imagem `rgb` tem 6x4 pixels e uma cor por linha: ver `LINHAS`.
const LINHAS: [[u8; 3]; 4] = [[255, 0, 0], [170, 0, 85], [85, 0, 170], [0, 0, 255]];
const JXL_RGB: &str = "0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20000000096a786c6c0a000000e16a786c63ff0a1840fc40020802010030034b189b9c71840338800338204ac039050100204480081001224084ffff3ff8ffffa23ec61873aeb5f7dee79c730e014544444444646666def77e55555515fcffffc1ffff17f531c69873adbdf73ee79c73082822222222223333f3bef7abaaaaaae0ffff0ffeffbfa88f31c69c6bedbdf739e79c43401111111111999999f7bd5f55555505ffff7ff0ffff457d8c31e65c6befbdcf39e71c028a88888888c8ccccbceffdaaaaaaaa03f0e5ff0300000000003ffeff00fc4c5501f0335505c0cf541500dffd7f000000000000";
const JXL_RGBA: &str = "0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20000000096a786c6c0a000000466a786c63ff0a1840fc087e800408101000bc004b18938e85838414a85e0c00de5f400880f7ff2f5555aaaa54d5f7ff43aaaa5455a9aade20c03551a5aa8001030600";
const JXL_PERDA: &str = "ff0a1840fc6402010c01f3431300800a9551c60d5ecef57cf9a1c362dac67586b6dab6b084b1d95e1824249cc0c6857d37071d236fb05d905249220de26e0a04775a1d7800c8684056050e8000";
/// 2x2 (200, 100, 50) com alfa 128 e um canal extra de profundidade (libjxl 0.11, sem perdas).
const JXL_ALFA_E_PROFUNDIDADE: &str = "ff0a081050288004084000010058004b188b15c209326fa85f07d87b1217a382b160008801";
const JXL_CINZA: &str = "0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20000000096a786c6c0a0000002b6a786c63ff0a1840fc00c58d0804010054004b2824c6454142c27942ff0cce82ee0f947fa0fb03";
const J2K_RGB: &str = "ff4fff51002f0000000000060000000400000000000000000000000600000004000000000000000000030f01010f01010f0101ff52000c00000001010204040001ff5c000a4080888890888890ff640025000143726561746564206279204f70656e4a5045472076657273696f6e20322e352e34ff90000a00000000004d0001ff93cffc300c093f4fcffc300801dfdff8902002455d3f80a7fe2404025fa7fe2404091780a3ff0604800b3c23cbb3bbbbbbbfa3ff0604800c1715e5d9dddddddfffd9";
/// 4x4 de uma cor só (200, 100, 50), DXT1.
const DDS: &str = "444453207c00000007100a000400000004000000080000000000000003000000494d4147454d414749434b00000000000000000000000000000000000000000000000000000000000000000020000000040000004458543100000000000000000000000000000000000000000810400000000000000000000000000000000000effdc2a9ffffffffeffdc2a9afafaaaaeffdc2a9abaaaaaa";
/// AVIF 16x16 de uma cor, 10 bits, `nclx` 2/2/9 (os testes trocam primárias e transferência).
const AVIF_10: &str = "00000020667479706176696600000000617669666d6966316d6961664d413142000000f96d657461000000000000002f68646c720000000000000000706963740000000000000000000000005069637475726548616e646c6572000000000e7069746d0000000000010000001e696c6f630000000044000001000100000001000001210000001f0000002869696e660000000000010000001a696e6665020000000001000061763031436f6c6f72000000006a697072700000004b6970636f0000001469737065000000000000001000000010000000107069786900000000030a0a0a0000000c6176314381004c0000000013636f6c726e636c78000200020009000000001769706d61000000000000000100010401028304000000276d6461740a09180cffdba0404120803212180000005000000000a98ceb1263ac574f80";

fn hex(h: &str) -> Vec<u8> {
    (0..h.len() / 2).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn abre(nome: &str, bytes: &[u8]) -> Decoded {
    decode_bytes(Path::new(nome), bytes).unwrap_or_else(|e| panic!("{nome}: {e}"))
}

#[track_caller]
fn perto(got: [u8; 4], want: [u8; 4], tol: u8) {
    assert!(got.iter().zip(want).all(|(g, w)| g.abs_diff(w) <= tol), "obtido {got:?}, esperado {want:?}");
}

#[track_caller]
fn confere_linhas(d: &Decoded, tol: u8) {
    assert_eq!(d.frames[0].dimensions(), (6, 4));
    for (y, [r, g, b]) in LINHAS.into_iter().enumerate() {
        for x in 0..6 {
            perto(d.frames[0].get_pixel(x, y as u32).0, [r, g, b, 255], tol);
        }
    }
}

/// Nome do formato como a interface o recebe.
fn formato(nome: &str, bytes: &[u8]) -> Option<String> {
    detect_format(Path::new(nome), bytes).map(|f| serde_json::to_value(f).unwrap().as_str().unwrap().into())
}

fn exr_de(img: &RgbaImage, half: bool) -> Vec<u8> {
    let opts = ExportOptions { exr_half: half, ..ExportOptions::new(ExportFormat::Exr) };
    encode(img, &opts, &MetaCarry::default()).unwrap()
}

/// EXR com valores lineares arbitrários.
fn exr_linear(w: usize, h: usize, at: impl Fn(usize, usize) -> (f32, f32, f32, f32) + Sync) -> Vec<u8> {
    use exr::prelude::*;
    let mut c = Cursor::new(Vec::new());
    Image::from_channels(
        (w, h),
        SpecificChannels::rgba(|p: Vec2<usize>| at(p.x(), p.y())),
    )
    .write()
    .to_buffered(&mut c)
    .unwrap();
    c.into_inner()
}

fn hdr_de(w: u32, h: u32, px: &[[f32; 3]]) -> Vec<u8> {
    let mut b = Vec::new();
    let px: Vec<image::Rgb<f32>> = px.iter().map(|p| image::Rgb(*p)).collect();
    image::codecs::hdr::HdrEncoder::new(&mut b).encode(&px, w as usize, h as usize).unwrap();
    b
}

fn png_de(cor: [u8; 4]) -> Vec<u8> {
    let mut c = Cursor::new(Vec::new());
    RgbaImage::from_pixel(4, 4, Rgba(cor)).write_to(&mut c, image::ImageFormat::Png).unwrap();
    c.into_inner()
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32fast::hash(&body).to_be_bytes());
    out
}

/// PNG com blocos a mais logo depois do IHDR.
fn com_chunks(png: &[u8], extra: &[Vec<u8>]) -> Vec<u8> {
    let mut out = png[..33].to_vec();
    extra.iter().for_each(|c| out.extend_from_slice(c));
    out.extend_from_slice(&png[33..]);
    out
}

fn iccp(id: &str) -> Vec<u8> {
    use std::io::Write;
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&icc::profile_bytes(id).unwrap()).unwrap();
    let mut d = b"x\0\0".to_vec();
    d.extend(z.finish().unwrap());
    chunk(b"iCCP", &d)
}

fn chrm(v: [u32; 8]) -> Vec<u8> {
    chunk(b"cHRM", &v.into_iter().flat_map(u32::to_be_bytes).collect::<Vec<_>>())
}

const CHRM_P3: [u32; 8] = [31270, 32900, 68000, 32000, 26500, 69000, 15000, 6000];
const CHRM_SRGB: [u32; 8] = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];

fn nome_icc(d: &Decoded) -> Option<String> {
    d.icc.as_deref().map(|b| icc::describe(b).unwrap_or_default())
}

/// Como a tela mostra a cor do documento (em sRGB).
fn na_tela(d: &Decoded) -> [u8; 4] {
    let mut px = d.frames[0].get_pixel(0, 0).0;
    if let Some(p) = &d.icc {
        assert!(icc::convert_rgba8(&mut px, p, icc::srgb_icc()));
    }
    px
}

// ---------- Formatos ----------

#[test]
fn detecta_pelo_conteudo_e_lista_as_extensoes() {
    let exr = exr_de(&RgbaImage::new(2, 2), true);
    let hdr = hdr_de(2, 1, &[[0.5; 3]; 2]);
    let casos: [(&str, &[u8]); 9] = [
        ("exr", &exr),
        ("hdr", &hdr),
        ("pnm", b"P6\n1 1\n255\nabc"),
        ("icns", b"icns\0\0\0\x08"),
        ("j2c", &hex(J2K_RGB)),
        ("jxl", &hex(JXL_RGB)),
        ("jxl", &hex(JXL_PERDA)),
        ("dds", &hex(DDS)),
        ("farbfeld", b"farbfeld\0\0\0\x01\0\0\0\x01"),
    ];
    for (fmt, bytes) in casos {
        // A extensão errada não atrapalha.
        assert_eq!(formato("Ação.png", bytes).as_deref(), Some(fmt));
        assert_eq!(formato("sem-extensao", bytes).as_deref(), Some(fmt));
    }
    for ext in [
        "exr", "hdr", "pic", "pnm", "pbm", "pgm", "ppm", "pam", "icns", "j2k", "j2c", "jpc", "jpf", "jpx", "jxl",
        "dds", "ff",
    ] {
        assert!(is_supported_path(&PathBuf::from(format!("/a/Ação 1.{}", ext.to_uppercase()))), "{ext}");
    }
    // Texto que só parece PNM e conteúdo que não bate com a extensão.
    assert_eq!(formato("nota.txt", b"P6rder este texto"), None);
    assert!(matches!(decode_bytes(Path::new("a.jxl"), b"lixo"), Err(AppError::Corrupt(_))));
}

#[test]
fn nenhum_formato_novo_e_gravavel() {
    let dir = tmp("formatos-gravavel");
    let store = DocStore::new();
    for (nome, bytes) in [
        ("a.exr", exr_de(&RgbaImage::new(2, 2), true)),
        ("a.ppm", b"P6\n1 1\n255\nabc".to_vec()),
        ("a.j2k", hex(J2K_RGB)),
        ("a.jxl", hex(JXL_RGB)),
        ("a.dds", hex(DDS)),
    ] {
        let p = dir.join(nome);
        std::fs::write(&p, bytes).unwrap();
        let info = store.open_documents(&[s(&p)]).remove(0);
        assert_eq!(info.error, None, "{nome}");
        assert!(!info.writable, "{nome}: Salvar leva a Exportar");
    }
}

#[test]
fn exr_exportado_volta_igual() {
    let img = RgbaImage::from_fn(16, 16, |x, y| Rgba([(x * 17) as u8, (y * 17) as u8, 90, 255]));
    for half in [true, false] {
        let d = abre("a.exr", &exr_de(&img, half));
        assert_eq!(d.frames[0].dimensions(), (16, 16));
        for (a, b) in d.frames[0].pixels().zip(img.pixels()) {
            perto(a.0, b.0, 1);
        }
    }
    // Semitransparente: o alfa do EXR é pré-multiplicado, e a leitura o desfaz.
    let img = RgbaImage::from_pixel(4, 4, Rgba([200, 100, 50, 128]));
    let bytes = exr_de(&img, false);
    let cru = image::load_from_memory(&bytes).unwrap().into_rgba32f().get_pixel(0, 0).0;
    let linear = ((200f32 / 255.0 + 0.055) / 1.055).powf(2.4);
    assert!((cru[0] - linear * 128.0 / 255.0).abs() < 1e-3, "{cru:?}");
    perto(abre("a.exr", &bytes).frames[0].get_pixel(0, 0).0, [200, 100, 50, 128], 1);
}

#[test]
fn exr_com_alcance_estendido_e_mapeado_sem_girar_o_matiz() {
    // Linha de 0 a 8 vezes o branco; alfa 1.
    let d = abre("luz.exr", &exr_linear(64, 1, |x, _| {
        let v = x as f32 / 63.0 * 8.0;
        (v, v / 2.0, 0.0, 1.0)
    }));
    let row: Vec<[u8; 4]> = d.frames[0].pixels().map(|p| p.0).collect();
    assert!(row.windows(2).all(|w| w[1][0] >= w[0][0] && w[1][1] >= w[0][1]), "monótono: {row:?}");
    perto(row[0], [0, 0, 0, 255], 0);
    // O pico vira o branco do canal e a metade linear continua metade (sRGB 188).
    perto(row[63], [255, 188, 0, 255], 1);
    // Valores que não são número ou infinitos não derrubam nem vazam.
    let d = abre("nan.exr", &exr_linear(2, 1, |x, _| {
        if x == 0 { (f32::NAN, f32::INFINITY, -1.0, 1.0) } else { (0.2, 0.2, 0.2, 1.0) }
    }));
    perto(d.frames[0].get_pixel(0, 0).0, [0, 255, 0, 255], 0);
    perto(d.frames[0].get_pixel(1, 0).0, [124, 124, 124, 255], 1);
}

#[test]
fn exr_so_com_luminancia_abre_em_cinza() {
    use exr::prelude::*;
    let mut c = Cursor::new(Vec::new());
    let canais = SpecificChannels::build().with_channel("Y").with_pixel_fn(|_| (0.2f32,));
    Image::from_channels((4, 3), canais).write().to_buffered(&mut c).unwrap();
    let d = abre("y.exr", &c.into_inner());
    assert_eq!(d.frames[0].dimensions(), (4, 3));
    perto(d.frames[0].get_pixel(0, 0).0, [124, 124, 124, 255], 1);
}

/// Blocos de 16 linhas (ZIP16) numa imagem larga e baixa: os blocos em voo pesam mais que os
/// pixels, e a estimativa conta o mesmo que o decodificador exige.
#[test]
fn estimativa_do_exr_conta_os_blocos_em_voo() {
    use exr::prelude::*;
    let (w, h) = (4096usize, 1usize);
    let canais = SpecificChannels::rgb(|_: Vec2<usize>| (0.5f32, 0.25f32, 0.125f32));
    let enc = Encoding { compression: Compression::ZIP16, blocks: Blocks::ScanLines, line_order: LineOrder::Increasing };
    let layer = Layer::new((w, h), LayerAttributes::named("ação"), enc, canais);
    let mut c = Cursor::new(Vec::new());
    Image::from_layer(layer).write().to_buffered(&mut c).unwrap();
    let b = c.into_inner();
    let bloco = 16 * w * 12;
    let est = estimate_bytes(Path::new("a.exr"), &b);
    assert!(est >= w * h * 20 + bloco * 3, "estimativa {est} sem os blocos de {bloco} bytes");
    assert_eq!(abre("a.exr", &b).frames[0].dimensions(), (4096, 1));
}

/// Cabeçalho que declara dimensões absurdas: recusa antes de alocar.
#[test]
fn exr_gigante_e_recusado() {
    let mut b = exr_de(&RgbaImage::new(2, 2), true);
    for nome in [&b"dataWindow\0box2i\0"[..], b"displayWindow\0box2i\0"] {
        let at = b.windows(nome.len()).position(|w| w == nome).unwrap() + nome.len() + 4;
        b[at + 8..at + 12].copy_from_slice(&99_999i32.to_le_bytes());
        b[at + 12..at + 16].copy_from_slice(&99_999i32.to_le_bytes());
    }
    assert!(decode_bytes(Path::new("g.exr"), &b).is_err());
    assert!(estimate_bytes(Path::new("g.exr"), &b) <= MAX_DECODE_BYTES);
}

#[test]
fn radiance_abre_com_o_mesmo_mapeamento() {
    let d = abre("a.hdr", &hdr_de(2, 1, &[[0.5, 0.25, 0.0], [0.2, 0.2, 0.2]]));
    perto(d.frames[0].get_pixel(0, 0).0, [188, 137, 0, 255], 2);
    perto(d.frames[0].get_pixel(1, 0).0, [124, 124, 124, 255], 2);
    let d = abre("b.hdr", &hdr_de(2, 1, &[[16.0, 8.0, 0.0], [0.2, 0.2, 0.2]]));
    perto(d.frames[0].get_pixel(0, 0).0, [255, 188, 0, 255], 2);
    perto(d.frames[0].get_pixel(1, 0).0, [124, 124, 124, 255], 2);
    let gigante = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 99999 +X 99999\n".to_vec();
    assert!(matches!(decode_bytes(Path::new("g.hdr"), &gigante), Err(AppError::Unsupported(_))));
}

#[test]
fn pnm_em_todas_as_variantes() {
    let px = |nome: &str, b: &[u8]| abre(nome, b).frames[0].get_pixel(0, 0).0;
    assert_eq!(px("a.pbm", b"P1\n# nota\n2 1\n0 1\n"), [255, 255, 255, 255]);
    assert_eq!(px("a.pbm", b"P4\n8 1\n\x80"), [0, 0, 0, 255]);
    assert_eq!(px("a.pgm", b"P2\n1 1\n15\n5\n"), [85, 85, 85, 255]);
    assert_eq!(px("a.pgm", b"P5\n1 1\n255\n\x64"), [100, 100, 100, 255]);
    assert_eq!(px("a.pgm", b"P5\n1 1\n65535\n\x80\x00"), [128, 128, 128, 255]);
    assert_eq!(px("a.ppm", b"P3\n1 1\n255\n10 20 30\n"), [10, 20, 30, 255]);
    assert_eq!(px("a.ppm", b"P6\n1 1\n255\n\x0a\x14\x1e"), [10, 20, 30, 255]);
    let pam = b"P7\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n\x0a\x14\x1e\x28";
    assert_eq!(px("a.pam", pam), [10, 20, 30, 40]);
    assert!(matches!(
        decode_bytes(Path::new("g.ppm"), b"P6\n99999 99999\n255\n"),
        Err(AppError::Unsupported(_))
    ));
    assert!(decode_bytes(Path::new("c.ppm"), b"P6\n4 4\n255\nabc").is_err(), "truncado");
}

#[test]
fn jpeg_2000_sem_conteiner() {
    for nome in ["a.j2k", "a.j2c", "a.jpc", "a.jpx"] {
        confere_linhas(&abre(nome, &hex(J2K_RGB)), 0);
    }
    let mut gigante = hex(J2K_RGB);
    gigante[8..12].copy_from_slice(&99_999u32.to_be_bytes());
    gigante[12..16].copy_from_slice(&99_999u32.to_be_bytes());
    assert!(decode_bytes(Path::new("g.j2k"), &gigante).is_err());
}

#[test]
fn jpeg_xl() {
    let d = abre("a.jxl", &hex(JXL_RGB));
    confere_linhas(&d, 1);
    confere_linhas(&abre("perda.jxl", &hex(JXL_PERDA)), 12);
    let d = abre("rgba.jxl", &hex(JXL_RGBA));
    assert_eq!(d.frames[0].get_pixel(0, 0).0[3], 128);
    perto(d.frames[0].get_pixel(0, 0).0, [255, 0, 0, 128], 1);
    let p = abre("cinza.jxl", &hex(JXL_CINZA)).frames[0].get_pixel(0, 0).0;
    assert!(p[0] == p[1] && p[1] == p[2] && p[3] == 255, "{p:?}");
}

/// Canais extras além do alfa (profundidade, seleção...) não impedem de abrir: valem cor e alfa.
#[test]
fn jpeg_xl_com_alfa_e_canais_extras_abre_com_cor_e_alfa() {
    let d = abre("ação.jxl", &hex(JXL_ALFA_E_PROFUNDIDADE));
    perto(d.frames[0].get_pixel(1, 1).0, [200, 100, 50, 128], 1);
}

/// `.pic` também é extensão de PICT e Softimage: só abre como Radiance com a assinatura dele.
#[test]
fn pic_so_e_radiance_com_a_assinatura() {
    let pict = [vec![0u8; 512], vec![0x00, 0x0A, 0, 0, 0, 0, 0, 2, 0, 2, 0x00, 0x11, 0x02, 0xFF]].concat();
    let softimage = b"\x53\x80\xF6\x34\0\0\0\0Softimage PIC".to_vec();
    for (nome, bytes) in [("ação.pic", pict), ("b.PIC", softimage)] {
        assert_eq!(formato(nome, &bytes), None, "{nome}");
        match decode_bytes(Path::new(nome), &bytes) {
            Err(AppError::Corrupt(m)) => assert!(m.contains("não corresponde"), "{m}"),
            other => panic!("{nome}: {:?}", other.map(|_| ())),
        }
    }
    for assinatura in ["#?RADIANCE", "#?RGBE"] {
        let b = format!("{assinatura}\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n").into_bytes();
        assert_eq!(formato("a.pic", &b).as_deref(), Some("hdr"), "{assinatura}");
    }
}

#[test]
fn dds_e_farbfeld() {
    let d = abre("a.dds", &hex(DDS));
    assert_eq!(d.frames[0].dimensions(), (4, 4));
    perto(d.frames[0].get_pixel(0, 0).0, [200, 100, 50, 255], 8);
    let mut ff = b"farbfeld".to_vec();
    for v in [1u32, 1] {
        ff.extend(v.to_be_bytes());
    }
    for v in [200u16 * 257, 100 * 257, 50 * 257, 128 * 257] {
        ff.extend(v.to_be_bytes());
    }
    assert_eq!(abre("a.ff", &ff).frames[0].get_pixel(0, 0).0, [200, 100, 50, 128]);
    ff[8..12].copy_from_slice(&99_999u32.to_be_bytes());
    ff[12..16].copy_from_slice(&99_999u32.to_be_bytes());
    assert!(matches!(decode_bytes(Path::new("g.ff"), &ff), Err(AppError::Unsupported(_))));
}

#[test]
fn dezesseis_bits_contam_a_memoria_de_trabalho() {
    // Farbfeld (sempre 16 bits) e PNM com maxval > 255: o buffer de 16 bits fica vivo junto do
    // RGBA8 final (~12 B/px). 15000² passa na conta de 4 B/px, mas não na real.
    let mut ff = b"farbfeld".to_vec();
    for v in [15_000u32, 15_000] {
        ff.extend(v.to_be_bytes());
    }
    let grande = |r: Result<_, AppError>| matches!(r, Err(AppError::Unsupported(m)) if m.contains("grande demais"));
    assert!(grande(decode_bytes(Path::new("g.ff"), &ff)), "farbfeld recusado antes de alocar");
    assert!(grande(decode_bytes(Path::new("g.ppm"), b"P6\n15000 15000\n65535\n")), "ppm de 16 bits");
    assert!(!grande(decode_bytes(Path::new("p.ppm"), b"P6\n15000 15000\n255\n")), "ppm de 8 bits continua na conta de 4 B/px");
    let mut ff16 = b"farbfeld".to_vec();
    for v in [16u32, 16] {
        ff16.extend(v.to_be_bytes());
    }
    assert_eq!(estimate_bytes(Path::new("a.ff"), &ff16), 16 * 16 * 12);
    assert_eq!(estimate_bytes(Path::new("a.ppm"), b"P6\n16 16\n65535\n"), 16 * 16 * 12);
}

// ---------- ICNS ----------

fn icns(itens: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (tipo, dados) in itens {
        body.extend_from_slice(*tipo);
        body.extend((dados.len() as u32 + 8).to_be_bytes());
        body.extend_from_slice(dados);
    }
    let mut out = b"icns".to_vec();
    out.extend((body.len() as u32 + 8).to_be_bytes());
    out.extend(body);
    out
}

fn png_lado(lado: u32, cor: [u8; 4]) -> Vec<u8> {
    let mut c = Cursor::new(Vec::new());
    RgbaImage::from_pixel(lado, lado, Rgba(cor)).write_to(&mut c, image::ImageFormat::Png).unwrap();
    c.into_inner()
}

/// `n` bytes iguais no RLE do ICNS.
fn rle(valor: u8, mut n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 3 {
        let k = n.min(130);
        out.extend([(k + 125) as u8, valor]);
        n -= k;
    }
    if n > 0 {
        out.push(n as u8 - 1);
        out.extend(vec![valor; n]);
    }
    out
}

#[test]
fn icns_usa_o_maior_icone() {
    let b = icns(&[
        (b"TOC ", vec![0; 8]),
        (b"icp4", png_lado(16, [1, 2, 3, 255])),
        (b"ic08", png_lado(256, [200, 100, 50, 128])),
        (b"ic07", png_lado(128, [9, 9, 9, 255])),
    ]);
    let d = abre("app.icns", &b);
    assert_eq!(d.frames.len(), 1);
    assert_eq!(d.frames[0].dimensions(), (256, 256));
    assert_eq!(d.frames[0].get_pixel(0, 0).0, [200, 100, 50, 128]);
    // O maior corrompido: vale o seguinte.
    let b = icns(&[(b"ic08", b"\x89PNG\r\n\x1a\nlixo".to_vec()), (b"ic07", png_lado(128, [9, 8, 7, 255]))]);
    assert_eq!(abre("app.icns", &b).frames[0].dimensions(), (128, 128));
}

/// Cada candidato quebrado custa uma decodificação: no máximo três, do maior para o menor.
#[test]
fn icns_tenta_no_maximo_tres_icones_quebrados() {
    let quebrado = || b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\x04\0\0\0\x04\0\x08\x06\0\0\0lixo".to_vec();
    let bom = (b"is32", vec![9u8; 16 * 16 * 3]);
    let com = |n: usize| {
        let mut itens: Vec<(&[u8; 4], Vec<u8>)> = (0..n).map(|_| (b"ic10", quebrado())).collect();
        itens.push((bom.0, bom.1.clone()));
        icns(&itens)
    };
    assert_eq!(abre("ação.icns", &com(2)).frames[0].dimensions(), (16, 16));
    assert!(matches!(decode_bytes(Path::new("a.icns"), &com(3)), Err(AppError::Corrupt(_))));
}

#[test]
fn icns_argb_rle_e_mascara() {
    let canais = |cores: &[u8], n: usize| cores.iter().flat_map(|&c| rle(c, n)).collect::<Vec<u8>>();
    let mut argb = b"ARGB".to_vec();
    argb.extend(canais(&[128, 200, 100, 50], 32 * 32));
    let d = abre("a.icns", &icns(&[(b"ic05", argb)]));
    assert_eq!(d.frames[0].dimensions(), (32, 32));
    assert_eq!(d.frames[0].get_pixel(31, 31).0, [200, 100, 50, 128]);
    // 24 bits com máscara separada; o it32 começa com quatro zeros.
    let b = icns(&[(b"is32", canais(&[10, 20, 30], 256)), (b"s8mk", vec![77; 256])]);
    assert_eq!(abre("a.icns", &b).frames[0].get_pixel(3, 3).0, [10, 20, 30, 77]);
    let mut it32 = vec![0; 4];
    it32.extend(canais(&[10, 20, 30], 128 * 128));
    let d = abre("a.icns", &icns(&[(b"it32", it32)]));
    assert_eq!(d.frames[0].dimensions(), (128, 128));
    assert_eq!(d.frames[0].get_pixel(127, 127).0, [10, 20, 30, 255], "sem máscara é opaco");
}

#[test]
fn icns_sem_icone_ou_mentiroso_e_recusado() {
    for ruim in [
        icns(&[]),
        icns(&[(b"ICN#", vec![0; 256])]),
        icns(&[(b"is32", vec![0x7F])]),
        icns(&[(b"it32", vec![0; 4])]),
        // PNG que diz ter 20000 px dentro do ícone.
        icns(&[(b"ic10", {
            let mut p = png_lado(16, [0; 4]);
            p[16..20].copy_from_slice(&20_000u32.to_be_bytes());
            p[20..24].copy_from_slice(&20_000u32.to_be_bytes());
            p
        })]),
        b"icns\xff\xff\xff\xffic08\xff\xff\xff\xff".to_vec(),
        b"icns\0\0\0\x10ic08\0\0\0\0".to_vec(),
    ] {
        assert!(decode_bytes(Path::new("a.icns"), &ruim).is_err(), "{} bytes", ruim.len());
    }
}

// ---------- Robustez ----------

/// Arquivos truncados e adulterados em cada byte viram erro (ou imagem), nunca pânico.
#[test]
fn truncados_e_adulterados_nao_derrubam() {
    let img = RgbaImage::from_fn(6, 4, |x, y| Rgba([x as u8 * 40, y as u8 * 60, 9, 200]));
    let pam = b"P7\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n\x0a\x14\x1e\x28".to_vec();
    let mut argb = b"ARGB".to_vec();
    argb.extend((0..4).flat_map(|c| rle(c, 256)));
    let amostras: Vec<(&str, Vec<u8>)> = vec![
        ("a.exr", exr_de(&img, true)),
        ("a.hdr", hdr_de(9, 2, &[[0.5, 2.0, 0.1]; 18])),
        ("a.pam", pam),
        ("a.pgm", b"P2\n2 1\n15\n5 6\n".to_vec()),
        ("a.icns", icns(&[(b"ic04", argb), (b"is32", rle(5, 768)), (b"s8mk", vec![1; 256])])),
        ("a.j2k", hex(J2K_RGB)),
        ("a.jxl", hex(JXL_RGB)),
        ("b.jxl", hex(JXL_PERDA)),
        ("a.dds", hex(DDS)),
        ("a.avif", avif(9, 16)),
        ("c.png", com_chunks(&png_de([1, 2, 3, 255]), &[chrm(CHRM_P3), chunk(b"gAMA", &50_000u32.to_be_bytes())])),
    ];
    for (nome, bytes) in &amostras {
        let tenta = |b: &[u8], o_que: &str| {
            let r = catch_unwind(|| decode_bytes(Path::new(nome), b).map(|d| d.bytes()));
            match r {
                Ok(Ok(n)) => assert!(n <= MAX_DECODE_BYTES, "{nome} {o_que}"),
                Ok(Err(_)) => {}
                Err(_) => panic!("{nome} {o_que}: pânico"),
            }
            estimate_bytes(Path::new(nome), b);
        };
        for n in 0..bytes.len() {
            tenta(&bytes[..n], &format!("truncado em {n}"));
        }
        for i in 0..bytes.len() {
            for v in [0x00, 0x7F, 0xFF] {
                let mut b = bytes.clone();
                b[i] = v;
                tenta(&b, &format!("byte {i} = {v:#x}"));
            }
        }
    }
}

// ---------- Cor sem ICC ----------

fn avif(primarias: u16, transferencia: u16) -> Vec<u8> {
    let mut b = hex(AVIF_10);
    let at = b.windows(4).position(|w| w == b"nclx").unwrap() + 4;
    b[at..at + 2].copy_from_slice(&primarias.to_be_bytes());
    b[at + 2..at + 4].copy_from_slice(&transferencia.to_be_bytes());
    b
}

#[test]
fn avif_com_nclx_vira_perfil() {
    let base = abre("a.avif", &avif(1, 13));
    assert_eq!(base.icc, None, "sRGB continua sem perfil");
    let cru = base.frames[0].get_pixel(0, 0).0;
    assert_eq!(abre("a.avif", &avif(2, 2)).icc, None, "não especificado continua sRGB");
    assert_eq!(abre("a.avif", &avif(1, 1)).icc, None, "BT.709 continua como sRGB");

    let p3 = abre("a.avif", &avif(12, 13));
    assert_eq!(nome_icc(&p3).as_deref(), Some("Display P3"));
    assert_eq!(p3.frames[0].get_pixel(0, 0).0, cru, "os pixels não mudam, só o perfil");
    let mut want = cru;
    assert!(icc::convert_rgba8(&mut want, &icc::profile_bytes("display-p3").unwrap(), icc::srgb_icc()));
    assert_eq!(na_tela(&p3), want);

    let rec = abre("a.avif", &avif(9, 14));
    assert!(nome_icc(&rec).unwrap().contains("2020"), "{:?}", nome_icc(&rec));
    assert_ne!(na_tela(&rec), cru);
}

#[test]
fn avif_pq_e_hlg_viram_sdr() {
    let cru = abre("a.avif", &avif(9, 13));
    for (transferencia, curva) in [(16, pq as fn(f32) -> f32), (18, hlg)] {
        let d = abre("a.avif", &avif(9, transferencia));
        // As primárias ficam: só a curva muda.
        // O cabeçalho ICC (bytes 24..36) leva a hora da criação: pode virar o segundo entre as duas.
        let sem_data = |i: &Option<Vec<u8>>| i.clone().map(|mut v| { v[24..36].fill(0); v });
        assert_eq!(sem_data(&d.icc), sem_data(&cru.icc), "{transferencia}");
        let (a, b) = (cru.frames[0].get_pixel(0, 0).0, d.frames[0].get_pixel(0, 0).0);
        assert_ne!(a, b, "{transferencia}");
        let lin: Vec<f32> = a[..3].iter().map(|&v| curva(v as f32 / 255.0)).collect();
        let k = if transferencia == 18 {
            (0.2627 * lin[0] + 0.6780 * lin[1] + 0.0593 * lin[2]).powf(0.2) * 1000.0 / 203.0
        } else {
            1.0
        };
        // Cor única: o pico é o próprio pixel, que só desce para 1 se passar do branco.
        let m = lin.iter().fold(0f32, |m, v| m.max(v * k));
        let escala = if m > 1.0 { 1.0 / m } else { 1.0 };
        let want: Vec<u8> = lin.iter().map(|v| srgb(v * k * escala)).collect();
        perto(b, [want[0], want[1], want[2], 255], 3);
    }
}

// Constantes do BT.2100 como a norma as escreve.
#[allow(clippy::excessive_precision)]
fn pq(v: f32) -> f32 {
    let e = v.powf(1.0 / 78.84375);
    ((e - 0.8359375).max(0.0) / (18.8515625 - 18.6875 * e)).powf(1.0 / 0.1593017578125) * 10000.0 / 203.0
}

#[allow(clippy::excessive_precision)]
fn hlg(v: f32) -> f32 {
    if v <= 0.5 { v * v / 3.0 } else { (((v - 0.55991073) / 0.17883277).exp() + 0.28466892) / 12.0 }
}

fn srgb(v: f32) -> u8 {
    let e = if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (e.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[test]
fn heic_com_icc_vence_o_nclx() {
    let img = RgbaImage::from_pixel(32, 32, Rgba([200, 100, 50, 255]));
    let opts = ExportOptions { color_profile: Some("adobe-rgb".into()), ..ExportOptions::new(ExportFormat::Heic) };
    // Sem o Kvazaar não há como gravar HEIC: o mesmo caminho é conferido no AVIF acima.
    let Ok(bytes) = encode(&img, &opts, &MetaCarry::default()) else { return };
    assert_eq!(nome_icc(&abre("a.heic", &bytes)), icc::describe(&icc::profile_bytes("adobe-rgb").unwrap()));
}

#[test]
fn png_segue_a_precedencia_da_especificacao() {
    let base = png_de([200, 100, 50, 255]);
    let cicp = |p: u8, t: u8, m: u8, f: u8| chunk(b"cICP", &[p, t, m, f]);
    let srgb = || chunk(b"sRGB", &[0]);
    let gama = |v: u32| chunk(b"gAMA", &v.to_be_bytes());
    let nome = |extra: &[Vec<u8>]| nome_icc(&abre("a.png", &com_chunks(&base, extra)));
    // Blocos que a crate `png` recusa de vez (o arquivo não abre): basta não valer um perfil errado.
    let recusado_ou = |extra: &[Vec<u8>], want: Option<String>| {
        if let Ok(d) = decode_bytes(Path::new("a.png"), &com_chunks(&base, extra)) {
            assert_eq!(nome_icc(&d), want, "{extra:?}");
        }
    };
    let p3 = Some("Display P3".to_string());
    let adobe = icc::describe(&icc::profile_bytes("adobe-rgb").unwrap());

    assert_eq!(nome(&[]), None, "sem nada continua sRGB");
    assert_eq!(nome(&[cicp(12, 13, 0, 1)]), p3);
    assert_eq!(nome(&[cicp(12, 13, 0, 1), iccp("adobe-rgb"), srgb()]), p3, "cICP vence o iCCP");
    assert_eq!(nome(&[cicp(1, 13, 0, 1), iccp("adobe-rgb")]), None, "cICP sRGB também vence");
    assert_eq!(nome(&[iccp("adobe-rgb"), srgb(), gama(100_000), chrm(CHRM_P3)]), adobe);
    assert_eq!(nome(&[srgb(), gama(100_000), chrm(CHRM_P3)]), None, "sRGB vence gAMA e cHRM");
    // cICP que o app não lê (matriz YCbCr, faixa reduzida, pontos reservados): vale o seguinte.
    for ruim in [cicp(12, 13, 0, 0), cicp(2, 13, 0, 1), cicp(12, 200, 0, 1)] {
        assert_eq!(nome(&[ruim, iccp("adobe-rgb")]), adobe);
    }
    for ruim in [cicp(12, 13, 1, 1), chunk(b"cICP", &[12])] {
        recusado_ou(&[ruim, iccp("adobe-rgb")], adobe.clone());
    }
    // O gAMA de quase todo PNG da web, com ou sem o cHRM do sRGB.
    assert_eq!(nome(&[gama(45_455)]), None);
    assert_eq!(nome(&[gama(45_455), chrm(CHRM_SRGB)]), None);
    assert_eq!(nome(&[chrm(CHRM_SRGB)]), None);
    // Absurdos não contam.
    recusado_ou(&[gama(0)], None);
    for v in [1, u32::MAX] {
        assert_eq!(nome(&[gama(v)]), None, "gAMA {v}");
    }
    assert_eq!(nome(&[chrm([0; 8])]), None);
    // CRC errado: o bloco não vale.
    let mut quebrado = cicp(12, 13, 0, 1);
    *quebrado.last_mut().unwrap() ^= 1;
    recusado_ou(&[quebrado], None);
}

#[test]
fn png_com_gama_e_primarias_muda_na_tela() {
    let abre_com = |extra: &[Vec<u8>]| abre("a.png", &com_chunks(&png_de([200, 100, 50, 255]), extra));
    // gAMA 1,0: os valores são lineares.
    let linear = abre_com(&[chunk(b"gAMA", &100_000u32.to_be_bytes())]);
    let want = [200, 100, 50].map(|v| srgb(v as f32 / 255.0));
    perto(na_tela(&linear), [want[0], want[1], want[2], 255], 2);
    // gama 1,8 (Mac antigo).
    let mac = abre_com(&[chunk(b"gAMA", &55_556u32.to_be_bytes())]);
    let want = [200, 100, 50].map(|v| srgb((v as f32 / 255.0).powf(1.8)));
    perto(na_tela(&mac), [want[0], want[1], want[2], 255], 2);
    // cHRM do P3 com a curva do sRGB: o mesmo que o Display P3 (valores de image/icc.rs).
    let p3 = abre_com(&[chunk(b"gAMA", &45_455u32.to_be_bytes()), chrm(CHRM_P3)]);
    perto(na_tela(&p3), [215, 93, 31, 255], 2);
    assert!(icc::is_rgb_profile(p3.icc.as_deref().unwrap()));
}

/// O Salvar de um PNG de 16 bits com cICP PQ continua em 16 bits e com a cor da tela.
#[test]
fn png_pq_de_16_bits_salva_em_16_bits() {
    let dir = tmp("formatos-png-pq");
    let img = image::ImageBuffer::<Rgba<u16>, Vec<u16>>::from_fn(8, 4, |x, y| {
        Rgba([x as u16 * 9000, y as u16 * 15000, 20_000, 65535])
    });
    let mut c = Cursor::new(Vec::new());
    img.write_to(&mut c, image::ImageFormat::Png).unwrap();
    let p = dir.join("Pôr do sol.png");
    std::fs::write(&p, com_chunks(&c.into_inner(), &[chunk(b"cICP", &[9, 16, 0, 1])])).unwrap();
    let antes = abre("a.png", &std::fs::read(&p).unwrap());
    assert!(nome_icc(&antes).unwrap().contains("2020"));
    let store = DocStore::new();
    let id = store.open_documents(&[s(&p)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.apply_op(id, gera_view_image_lib::doc::model::Op::FlipH).unwrap();
    store.save(id, None).unwrap();
    let bytes = std::fs::read(&p).unwrap();
    assert_eq!(bytes[24], 16, "bits por canal do IHDR");
    let depois = abre("a.png", &bytes);
    assert_eq!(nome_icc(&depois), nome_icc(&antes));
    for y in 0..4 {
        for x in 0..8 {
            perto(depois.frames[0].get_pixel(7 - x, y).0, antes.frames[0].get_pixel(x, y).0, 1);
        }
    }
}

// ---------- Tetos de memória dos decodificadores (achados da checagem de segurança) ----------

fn grande_demais(r: Result<Decoded, AppError>) {
    match r {
        Err(AppError::Unsupported(m)) => assert!(m.contains("grande demais"), "{m}"),
        Err(e) => panic!("recusado pelo motivo errado: {e:?}"),
        Ok(_) => panic!("aceito"),
    }
}

/// EXR pequeno cujo `dataWindow` declara 16384x8192 com 40 canais f32: 4 bytes/pixel cabem no
/// teto, os 160 do total não. A janela de exibição fica 2x2, então nada grande é alocado.
#[test]
fn exr_conta_todos_os_canais_no_teto() {
    use exr::prelude::*;
    let nomes = ["R", "G", "B"].into_iter().map(String::from).chain((0..37).map(|i| format!("x{i:02}")));
    let canais = AnyChannels::sort(
        nomes.map(|n| AnyChannel::new(n.as_str(), FlatSamples::F32(vec![0.5; 4]))).collect(),
    );
    let layer = Layer::new((2, 2), LayerAttributes::named("a"), Encoding::UNCOMPRESSED, canais);
    let mut c = Cursor::new(Vec::new());
    Image::from_layer(layer).write().to_buffered(&mut c).unwrap();
    let mut b = c.into_inner();
    let nome = b"dataWindow\0box2i\0";
    let at = b.windows(nome.len()).position(|w| w == nome).unwrap() + nome.len() + 4;
    b[at + 8..at + 12].copy_from_slice(&16_383i32.to_le_bytes());
    b[at + 12..at + 16].copy_from_slice(&8_191i32.to_le_bytes());
    grande_demais(decode_bytes(Path::new("c.exr"), &b));
}

/// Bits de um codestream JPEG XL (o menos significativo primeiro).
struct Bits(Vec<u8>, usize);

impl Bits {
    fn put(&mut self, v: u32, n: usize) {
        for i in 0..n {
            if self.1.is_multiple_of(8) {
                self.0.push(0);
            }
            *self.0.last_mut().unwrap() |= (((v >> i) & 1) as u8) << (self.1 % 8);
            self.1 += 1;
        }
    }
}

/// Só a assinatura e o cabeçalho de um JPEG XL `w`x`h` (sem quadros).
fn jxl_so_cabecalho(w: u32, h: u32) -> Vec<u8> {
    let mut b = Bits(vec![0xff, 0x0a], 16);
    b.put(0, 1); // div8
    b.put(2, 2); // altura: 1 + u(18)
    b.put(h - 1, 18);
    b.put(0, 3); // sem proporção fixa
    b.put(2, 2);
    b.put(w - 1, 18);
    b.put(1, 1); // metadados padrão
    b.0.extend_from_slice(&[0; 16]);
    b.0
}

/// 16384x16384: o RGBA8 final (1 GiB) caberia; os planos f32 de trabalho não.
#[test]
fn jxl_conta_os_planos_de_trabalho_no_teto() {
    let b = jxl_so_cabecalho(16_384, 16_384);
    assert_eq!(formato("a.jxl", &b).as_deref(), Some("jxl"));
    grande_demais(decode_bytes(Path::new("a.jxl"), &b));
    assert_eq!(estimate_bytes(Path::new("a.jxl"), &b), MAX_DECODE_BYTES);
}

/// Caixa `brob` (Brotli) com 1 MiB de Exif em 20 bytes: não é descomprimida.
#[test]
fn jxl_ignora_caixas_brob() {
    const BROB: &str = "0000002062726f62457869669b0d0010f8a7019a5410c68181c0bbf70f508e01";
    let base = hex(JXL_RGB);
    let mut b = base[..32].to_vec(); // assinatura e ftyp
    b.extend_from_slice(&hex(BROB));
    b.extend_from_slice(&base[32..]);
    let d = abre("b.jxl", &b);
    confere_linhas(&d, 1);
    assert!(d.exif.is_none());
}

/// PQ/HLG passam por RGBA16 (e, no HEIF, por um plano de 16 bits): a estimativa conta isso.
#[test]
fn estimativa_conta_o_trabalho_do_hdr() {
    let png = png_de([10, 20, 30, 255]);
    assert_eq!(estimate_bytes(Path::new("a.png"), &png), 16 * 4);
    let pq = com_chunks(&png, &[chunk(b"cICP", &[9, 16, 0, 1])]);
    // RGB16 decodificado (6) e RGBA16 de trabalho (8) vivos juntos.
    assert_eq!(estimate_bytes(Path::new("a.png"), &pq), 16 * 14);
    let avif = hex(AVIF_10);
    assert_eq!(estimate_bytes(Path::new("a.avif"), &avif), 16 * 16 * 4);
    let at = avif.windows(8).position(|w| w == b"colrnclx").unwrap() + 8;
    for t in [16u16, 18] {
        let mut hdr = avif.clone();
        hdr[at + 2..at + 4].copy_from_slice(&t.to_be_bytes());
        assert_eq!(estimate_bytes(Path::new("a.avif"), &hdr), 16 * 16 * 20, "transfer {t}");
    }
}
