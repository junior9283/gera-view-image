//! Salvar sobre o original preserva o arquivo: metadados por formato (TIFF, AVIF, BMP),
//! palavras-chave, 16 bits, JPEG CMYK, XMP estendido e dimensões do EXIF.
//! Cada teste grava pelo app e relê o resultado (com o `exiv2` também, quando instalado).
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::{
        file::SaveOutcome,
        model::{ColorAdjust, CropSpec, DocId, Op, Rect, ResizeFilter},
        store::DocStore,
    },
    image::{
        decode::decode,
        encode::{ExportFormat, ExportOptions, MetaCarry, encode},
        metadata::{file_iim_xmp, parse_blocks},
        raster::Rgba16Image,
    },
};
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb, RgbImage, Rgba};
use make_fixtures::{ensure_fixtures, icc_profile_named, s, tmp};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn abre(store: &DocStore, path: &Path) -> DocId {
    let info = store.open_documents(&[s(path)]).remove(0);
    assert_eq!(info.error, None, "{}", path.display());
    store.wait_ready(info.id).unwrap();
    info.id
}

fn opts(format: ExportFormat) -> ExportOptions {
    ExportOptions {
        format,
        quality: None,
        alpha: true,
        depth16: false,
        strip_metadata: false,
        resize: None,
        color_profile: None,
        ..ExportOptions::new(ExportFormat::Png)
    }
}

fn salva(store: &DocStore, id: DocId, keywords: Option<Vec<String>>) {
    assert!(matches!(
        store.save(id, keywords).unwrap(),
        SaveOutcome::Saved(_)
    ));
}

fn gradiente(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 90])
    })
}

/// IFD little-endian com os valores fora da entrada logo depois dele (que começa em `at`).
fn ifd(at: u32, entries: &[(u16, u16, u32, Vec<u8>)]) -> Vec<u8> {
    let extra_at = at + 2 + 12 * entries.len() as u32 + 4;
    let mut head = (entries.len() as u16).to_le_bytes().to_vec();
    let mut tail = Vec::new();
    for (tag, ty, count, data) in entries {
        head.extend(tag.to_le_bytes());
        head.extend(ty.to_le_bytes());
        head.extend(count.to_le_bytes());
        if data.len() <= 4 {
            let mut d = data.clone();
            d.resize(4, 0);
            head.extend(d);
        } else {
            head.extend((extra_at + tail.len() as u32).to_le_bytes());
            tail.extend(data);
            if tail.len() % 2 == 1 {
                tail.push(0);
            }
        }
    }
    head.extend(0u32.to_le_bytes());
    head.extend(tail);
    head
}

/// EXIF com Make/Model no IFD0 e um sub-IFD EXIF com DateTimeOriginal e PixelX/YDimension.
fn exif_completo(w: u16, h: u16) -> Vec<u8> {
    let ifd0 = |exif_at: u32| {
        ifd(
            8,
            &[
                (0x010F, 2, 5, b"Gera\0".to_vec()),
                (0x0110, 2, 8, b"TestCam\0".to_vec()),
                (0x8769, 4, 1, exif_at.to_le_bytes().to_vec()),
            ],
        )
    };
    let at = 8 + ifd0(0).len() as u32;
    let exif = ifd(
        at,
        &[
            (0x9003, 2, 20, b"2026:11:21 10:00:00\0".to_vec()),
            (0xA002, 3, 1, w.to_le_bytes().to_vec()),
            (0xA003, 3, 1, h.to_le_bytes().to_vec()),
        ],
    );
    [b"II*\0".as_slice(), &8u32.to_le_bytes(), &ifd0(at), &exif].concat()
}

fn iim(titulo: &str, keywords: &[&str]) -> Vec<u8> {
    let ds = |num: u8, v: &str| {
        let mut d = vec![0x1C, 2, num];
        d.extend_from_slice(&(v.len() as u16).to_be_bytes());
        d.extend_from_slice(v.as_bytes());
        d
    };
    let mut out = ds(5, titulo);
    for k in keywords {
        out.extend(ds(25, k));
    }
    out
}

fn xmp_com(titulo: &str, extra: &str) -> String {
    format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{titulo}</rdf:li></rdf:Alt></dc:title><dc:subject><rdf:Bag><rdf:li>mar</rdf:li><rdf:li>sol</rdf:li></rdf:Bag></dc:subject>{extra}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
}

/// JPEG 40x20 com EXIF (IFD0 + sub-IFD), ICC, IPTC e XMP.
fn jpeg_completo(dir: &Path) -> PathBuf {
    let meta = MetaCarry {
        exif: Some(exif_completo(40, 20)),
        icc: Some(icc_profile_named("Perfil Teste")),
        iptc: Some(iim("Praia", &["mar", "sol"])),
        xmp: Some(xmp_com("Título XMP", "")),
        iptc_keywords: None,
        text_edits: None,
        exif_cleared: None,
        dpi: None,
    };
    let rgba = DynamicImage::ImageRgb8(gradiente(40, 20)).into_rgba8();
    let path = dir.join("fonte.jpg");
    fs::write(&path, encode(&rgba, &opts(ExportFormat::Jpeg), &meta).unwrap()).unwrap();
    path
}

/// Exporta o JPEG completo para `ext`, abre o arquivo novo e devolve `(store, id, caminho)`.
fn completo_em(teste: &str, fmt: ExportFormat, ext: &str) -> (DocStore, DocId, PathBuf) {
    let dir = tmp(teste);
    let store = DocStore::new();
    let src = abre(&store, &jpeg_completo(&dir));
    let dest = dir.join(format!("foto.{ext}"));
    store.export(src, &s(&dest), &opts(fmt), None).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &dest);
    (store, id, dest)
}

fn exif_campo(exif: &[u8], tag: exif::Tag) -> Option<String> {
    let e = exif::Reader::new().read_raw(exif.to_vec()).ok()?;
    let f = e.get_field(tag, exif::In::PRIMARY)?;
    Some(match f.value.get_uint(0) {
        Some(v) => v.to_string(),
        None => f.display_value().to_string().trim_matches('"').to_string(),
    })
}

/// Saída do `exiv2 -pa` (todas as tags), ou `None` se ele não estiver instalado.
fn exiv2(path: &Path) -> Option<String> {
    let out = Command::new("exiv2").arg("-pa").arg(path).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn kw(v: &[&str]) -> Vec<String> {
    v.iter().map(|k| k.to_string()).collect()
}

#[test]
fn tiff_salvar_preserva_exif_iptc_xmp_icc_e_dpi() {
    let (store, id, path) = completo_em("tiff-meta", ExportFormat::Tiff, "tiff");
    store
        .apply_op(
            id,
            Op::Resize {
                w: 20,
                h: 10,
                filter: ResizeFilter::Bilinear,
                dpi: Some(300.0),
            },
        )
        .unwrap();
    salva(&store, id, None);

    let d = decode(&path).unwrap();
    assert_eq!(d.frames[0].dimensions(), (20, 10));
    assert_eq!(d.icc, Some(icc_profile_named("Perfil Teste")));
    let dpi = d.dpi.expect("dpi gravado");
    assert!((dpi.0 - 300.0).abs() < 1.0, "{dpi:?}");
    let exif = d.exif.as_deref().expect("EXIF do TIFF");
    assert_eq!(exif_campo(exif, exif::Tag::Make).as_deref(), Some("Gera"));
    assert_eq!(exif_campo(exif, exif::Tag::Model).as_deref(), Some("TestCam"));
    assert!(
        exif_campo(exif, exif::Tag::DateTimeOriginal)
            .unwrap()
            .contains("2026-11-21")
    );
    assert_eq!(exif_campo(exif, exif::Tag::PixelXDimension).as_deref(), Some("20"));
    assert_eq!(exif_campo(exif, exif::Tag::PixelYDimension).as_deref(), Some("10"));

    let bytes = fs::read(&path).unwrap();
    let b = parse_blocks(&bytes, d.exif.as_deref());
    assert!(b.iptc.contains(&("Title".into(), "Praia".into())), "{:?}", b.iptc);
    assert_eq!(b.keywords, kw(&["mar", "sol"]));
    let xmp = file_iim_xmp(&bytes).1.expect("XMP no TIFF");
    assert!(xmp.contains("Título XMP"));

    if let Some(tags) = exiv2(&path) {
        for t in [
            "Exif.Image.Make",
            "Exif.Photo.DateTimeOriginal",
            "Iptc.Application2.Keywords",
            "Xmp.dc.title",
        ] {
            assert!(tags.contains(t), "exiv2 não viu {t}:\n{tags}");
        }
    }
}

#[test]
fn avif_salvar_preserva_exif() {
    let (store, id, path) = completo_em("avif-meta", ExportFormat::Avif, "avif");
    store
        .apply_op(
            id,
            Op::Crop(CropSpec::from(Rect {
                x: 0,
                y: 0,
                w: 30,
                h: 16,
            })),
        )
        .unwrap();
    salva(&store, id, None);
    let d = decode(&path).unwrap();
    assert_eq!(d.frames[0].dimensions(), (30, 16));
    let exif = d.exif.as_deref().expect("EXIF do AVIF");
    assert_eq!(exif_campo(exif, exif::Tag::Make).as_deref(), Some("Gera"));
    assert_eq!(exif_campo(exif, exif::Tag::PixelXDimension).as_deref(), Some("30"));
}

#[test]
fn bmp_salvar_preserva_icc_no_cabecalho_v5() {
    let (store, id, path) = completo_em("bmp-icc", ExportFormat::Bmp, "bmp");
    store.apply_op(id, Op::FlipH).unwrap();
    salva(&store, id, None);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(u32::from_le_bytes(bytes[14..18].try_into().unwrap()), 124, "BITMAPV5HEADER");
    let d = decode(&path).unwrap();
    assert_eq!(d.frames[0].dimensions(), (40, 20));
    assert_eq!(d.icc, Some(icc_profile_named("Perfil Teste")));
    // O ImageMagick (leitor independente) também abre o BMP v5 com perfil.
    if let Ok(out) = Command::new("identify").arg(&path).output() {
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
}

#[test]
fn palavras_chave_gravadas_em_cada_formato_com_iptc_ou_xmp() {
    for (fmt, ext) in [
        (ExportFormat::Jpeg, "jpg"),
        (ExportFormat::Tiff, "tiff"),
        (ExportFormat::Png, "png"),
        (ExportFormat::Webp, "webp"),
    ] {
        let (store, id, path) = completo_em(&format!("kw-{ext}"), fmt, ext);
        store.apply_op(id, Op::FlipV).unwrap();
        let novas = kw(&["praia", "férias"]);
        salva(&store, id, Some(novas.clone()));
        let d = decode(&path).unwrap();
        let b = parse_blocks(&fs::read(&path).unwrap(), d.exif.as_deref());
        assert_eq!(b.keywords, novas, "{ext}");
        let xmp = file_iim_xmp(&fs::read(&path).unwrap()).1.expect(ext);
        assert!(xmp.contains("Título XMP"), "{ext}: o resto do XMP continua");
    }
}

/// Gradiente de 16 bits cujos valores não são múltiplos de 257 (não cabem em 8 bits).
fn gradiente16(w: u32, h: u32) -> Rgba16Image {
    ImageBuffer::from_fn(w, h, |x, y| {
        Rgba([
            (x * 1771 + y * 13) as u16,
            (y * 2531 + x * 7) as u16,
            (x * y * 37 + 1000) as u16,
            65535,
        ])
    })
}

#[test]
fn png_e_tiff_de_16_bits_continuam_com_16_bits() {
    for ext in ["png", "tiff"] {
        let dir = tmp(&format!("16bits-{ext}"));
        let path = dir.join(format!("fundo.{ext}"));
        let orig = DynamicImage::ImageRgb16(DynamicImage::ImageRgba16(gradiente16(37, 23)).into_rgb16());
        orig.save(&path).unwrap();

        // Só geometria: os 16 bits saem exatos.
        let store = DocStore::new();
        let id = abre(&store, &path);
        store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
        store
            .apply_op(
                id,
                Op::Crop(CropSpec::from(Rect {
                    x: 2,
                    y: 3,
                    w: 15,
                    h: 30,
                })),
            )
            .unwrap();
        store.apply_op(id, Op::FlipH).unwrap();
        salva(&store, id, None);
        let salvo = image::open(&path).unwrap();
        assert!(
            matches!(salvo.color(), image::ColorType::Rgb16 | image::ColorType::Rgba16),
            "{ext}: {:?}",
            salvo.color()
        );
        let esperado = image::imageops::flip_horizontal(
            &image::imageops::rotate90(&orig.to_rgb16()).view(2, 3, 15, 30).to_image(),
        );
        assert_eq!(salvo.to_rgb16(), esperado, "{ext}");

        // Ajuste de cor (em f32) e redimensionar: continua com 16 bits e perto do pipeline de 8.
        store
            .apply_op(
                id,
                Op::Adjust(ColorAdjust {
                    exposure: 0.4,
                    sharpness: 0.5,
                    ..Default::default()
                }),
            )
            .unwrap();
        store
            .apply_op(
                id,
                Op::Resize {
                    w: 10,
                    h: 20,
                    filter: ResizeFilter::Lanczos3,
                    dpi: None,
                },
            )
            .unwrap();
        let oito = store.render_full(id, 0).unwrap().clone();
        salva(&store, id, None);
        let salvo = image::open(&path).unwrap().to_rgb16();
        assert_eq!(salvo.dimensions(), (10, 20));
        assert!(
            salvo.as_raw().iter().any(|v| v % 257 != 0),
            "{ext}: os valores deveriam usar os 16 bits"
        );
        for (a, b) in salvo.pixels().zip(oito.pixels()) {
            for c in 0..3 {
                let d = (a[c] as f32 / 257.0 - b[c] as f32).abs();
                assert!(d <= 3.0, "{ext}: 16 bits {a:?} longe do 8 bits {b:?}");
            }
        }
    }
}

/// Insere um APP2 ICC_PROFILE depois do SOI.
fn com_icc(jpg: &[u8], icc: &[u8]) -> Vec<u8> {
    let mut payload = b"ICC_PROFILE\0\x01\x01".to_vec();
    payload.extend_from_slice(icc);
    let mut out = jpg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE2]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend(payload);
    out.extend_from_slice(&jpg[2..]);
    out
}

/// Componentes do quadro (SOF) de um JPEG.
fn componentes_jpeg(b: &[u8]) -> u8 {
    let mut i = 2;
    while i + 4 <= b.len() {
        let m = b[i + 1];
        if (0xC0..=0xC2).contains(&m) {
            return b[i + 9];
        }
        i += 2 + u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
    }
    panic!("JPEG sem SOF")
}

#[test]
fn jpeg_cmyk_vira_rgb_sem_o_perfil_cmyk() {
    let dir = tmp("cmyk");
    let path = dir.join("cmyk.jpg");
    let mut icc = icc_profile_named("Perfil CMYK");
    icc[16..20].copy_from_slice(b"CMYK");
    let orig = fs::read(ensure_fixtures().join("cmyk.jpg")).unwrap();
    assert_eq!(componentes_jpeg(&orig), 4);
    fs::write(&path, com_icc(&orig, &icc)).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    assert!(decode(&path).unwrap().icc.is_some(), "a fixture leva o perfil CMYK");
    store.apply_op(id, Op::FlipH).unwrap();
    let oito = store.render_full(id, 0).unwrap().clone();
    salva(&store, id, None);

    let bytes = fs::read(&path).unwrap();
    assert_eq!(componentes_jpeg(&bytes), 3, "regravado em RGB (YCbCr)");
    let d = decode(&path).unwrap();
    assert_eq!(d.icc, None, "perfil CMYK num JPEG RGB deixaria as cores erradas");
    let (a, b) = (d.frames[0].get_pixel(5, 5), oito.get_pixel(5, 5));
    for c in 0..3 {
        assert!((a[c] as i32 - b[c] as i32).abs() <= 12, "{a:?} x {b:?}");
    }
}

#[test]
fn perfil_cinza_tambem_nao_vai_para_saida_rgb() {
    let mut icc = icc_profile_named("Gray");
    icc[16..20].copy_from_slice(b"GRAY");
    let meta = MetaCarry {
        icc: Some(icc),
        ..MetaCarry::default()
    };
    let img = DynamicImage::ImageRgb8(gradiente(8, 8)).into_rgba8();
    let dir = tmp("cinza");
    for (fmt, ext) in [(ExportFormat::Jpeg, "jpg"), (ExportFormat::Png, "png")] {
        let p = dir.join(format!("x.{ext}"));
        fs::write(&p, encode(&img, &opts(fmt), &meta).unwrap()).unwrap();
        assert_eq!(decode(&p).unwrap().icc, None, "{ext}");
    }
}

/// Segmentos APP1 (payloads) de um JPEG.
fn app1(b: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 2;
    while i + 4 <= b.len() && b[i] == 0xFF && b[i + 1] != 0xDA {
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if b[i + 1] == 0xE1 {
            out.push(b[i + 4..i + 2 + len].to_vec());
        }
        i += 2 + len;
    }
    out
}

const EXT_NS: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
const STD_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

/// JPEG com XMP estendido montado à mão (padrão mínimo com o GUID + extensão em pedaços).
fn jpeg_xmp_estendido(full: &str) -> Vec<u8> {
    let guid = format!("{:X}", md5::compute(full.as_bytes()));
    let std = format!(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:xmpNote=\"http://ns.adobe.com/xmp/note/\" xmpNote:HasExtendedXMP=\"{guid}\"/></rdf:RDF></x:xmpmeta>"
    );
    let mut segs = vec![[STD_NS, std.as_bytes()].concat()];
    let chunk = 60_000;
    for (i, part) in full.as_bytes().chunks(chunk).enumerate() {
        let mut p = EXT_NS.to_vec();
        p.extend(guid.as_bytes());
        p.extend((full.len() as u32).to_be_bytes());
        p.extend(((i * chunk) as u32).to_be_bytes());
        p.extend(part);
        segs.push(p);
    }
    let jpg = make_fixtures::jpeg_bytes(&gradiente(16, 12), 90);
    let mut out = jpg[..2].to_vec();
    for p in segs {
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((p.len() + 2) as u16).to_be_bytes());
        out.extend(p);
    }
    out.extend_from_slice(&jpg[2..]);
    out
}

#[test]
fn xmp_maior_que_64k_no_jpeg_nao_some() {
    let dir = tmp("xmp-grande");
    let path = dir.join("grande.jpg");
    // ~150 KB de histórico (como o do Photoshop) e um marcador no fim.
    let historico: String = (0..3000)
        .map(|i| format!("<xmp:Evento{i} xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">passo {i}</xmp:Evento{i}>"))
        .collect();
    let full = xmp_com("Título XMP", &format!("{historico}<dc:rights>FIM-DO-XMP</dc:rights>"));
    assert!(full.len() > 140_000);
    fs::write(&path, jpeg_xmp_estendido(&full)).unwrap();

    let lido = file_iim_xmp(&fs::read(&path).unwrap()).1.unwrap();
    assert!(lido.contains("FIM-DO-XMP"), "a leitura reúne o XMP estendido");

    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipH).unwrap();
    salva(&store, id, Some(kw(&["nova"])));

    let bytes = fs::read(&path).unwrap();
    let xmp = file_iim_xmp(&bytes).1.expect("XMP");
    assert!(xmp.contains("FIM-DO-XMP") && xmp.contains("passo 2999"));
    assert!(!xmp.contains("HasExtendedXMP"), "a marca do estendido não vaza para o pacote");
    let d = decode(&path).unwrap();
    assert_eq!(parse_blocks(&bytes, d.exif.as_deref()).keywords, kw(&["nova"]));

    // Estrutura: padrão com o GUID e extensões cujo MD5 confere.
    let segs = app1(&bytes);
    let std = segs.iter().find_map(|s| s.strip_prefix(STD_NS)).expect("APP1 XMP padrão");
    let std = String::from_utf8_lossy(std);
    let ext: Vec<&[u8]> = segs.iter().filter_map(|s| s.strip_prefix(EXT_NS)).collect();
    assert!(ext.len() >= 3, "{} extensões", ext.len());
    let guid = std::str::from_utf8(&ext[0][..32]).unwrap();
    assert!(std.contains(&format!("HasExtendedXMP=\"{guid}\"")), "{std}");
    let total = u32::from_be_bytes(ext[0][32..36].try_into().unwrap()) as usize;
    let mut junto = vec![0u8; total];
    for e in &ext {
        assert_eq!(&e[..32], guid.as_bytes());
        let off = u32::from_be_bytes(e[36..40].try_into().unwrap()) as usize;
        junto[off..off + e.len() - 40].copy_from_slice(&e[40..]);
    }
    assert_eq!(format!("{:X}", md5::compute(&junto)), guid);
}

#[test]
fn exif_truncado_no_meio_do_pixel_x_nao_derruba_o_salvar() {
    // IFD0 -> sub-IFD EXIF cuja entrada PixelXDimension termina antes do valor.
    let mut exif = b"II*\0\x08\0\0\0".to_vec();
    exif.extend(1u16.to_le_bytes());
    exif.extend(0x8769u16.to_le_bytes());
    exif.extend(4u16.to_le_bytes());
    exif.extend(1u32.to_le_bytes());
    exif.extend(26u32.to_le_bytes());
    exif.extend(0u32.to_le_bytes());
    exif.extend(1u16.to_le_bytes());
    exif.extend(0xA002u16.to_le_bytes());
    exif.extend(3u16.to_le_bytes());
    exif.extend(1u32.to_le_bytes());
    let jpg = make_fixtures::jpeg_bytes(&gradiente(20, 10), 90);
    let payload = [b"Exif\0\0".as_slice(), &exif].concat();
    let mut out = jpg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend(payload);
    out.extend_from_slice(&jpg[2..]);
    let path = tmp("exif-truncado").join("t.jpg");
    fs::write(&path, out).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    store
        .apply_op(
            id,
            Op::Crop(CropSpec::from(Rect {
                x: 0,
                y: 0,
                w: 10,
                h: 5,
            })),
        )
        .unwrap();
    salva(&store, id, None);
    assert_eq!(decode(&path).unwrap().frames[0].dimensions(), (10, 5));
}

#[test]
fn pixel_dimension_do_exif_segue_recorte_e_redimensionar() {
    let dir = tmp("pixel-dims");
    let path = jpeg_completo(&dir);
    let store = DocStore::new();
    let id = abre(&store, &path);
    let dims = |p: &Path| {
        let e = decode(p).unwrap().exif.unwrap();
        (
            exif_campo(&e, exif::Tag::PixelXDimension).unwrap(),
            exif_campo(&e, exif::Tag::PixelYDimension).unwrap(),
        )
    };
    assert_eq!(dims(&path), ("40".into(), "20".into()));
    store
        .apply_op(
            id,
            Op::Crop(CropSpec::from(Rect {
                x: 4,
                y: 2,
                w: 30,
                h: 12,
            })),
        )
        .unwrap();
    salva(&store, id, None);
    assert_eq!(dims(&path), ("30".into(), "12".into()));
    store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
    salva(&store, id, None);
    assert_eq!(dims(&path), ("12".into(), "30".into()));
    store
        .apply_op(
            id,
            Op::Resize {
                w: 6,
                h: 15,
                filter: ResizeFilter::Bilinear,
                dpi: None,
            },
        )
        .unwrap();
    salva(&store, id, None);
    assert_eq!(dims(&path), ("6".into(), "15".into()));
    // O resto do EXIF continua.
    let e = decode(&path).unwrap().exif.unwrap();
    assert_eq!(exif_campo(&e, exif::Tag::Make).as_deref(), Some("Gera"));
}
