//! Inspetor completo (Lote 9): abas por formato, título/descrição/autor/texto alternativo gravados
//! no Salvar sem perder EXIF, ICC, IPTC e XMP, e arquivos truncados ou adulterados sem pânico.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    commands::describe::MetadataEdits,
    doc::{
        file::SaveOutcome,
        model::{DocId, Op, Rect, CropSpec},
        store::DocStore,
    },
    image::{
        decode::decode,
        encode::{ExportFormat, ExportOptions, MetaCarry, encode},
        formatinfo,
        metadata::{Metadata, parse_blocks, read_metadata},
    },
};
use image::{DynamicImage, Rgb, RgbImage};
use make_fixtures::{ensure_fixtures, icc_profile_named, s, tmp};
use std::{fs, path::Path};

fn meta(name: &str) -> Metadata {
    let path = ensure_fixtures().join(name);
    let decoded = decode(&path).unwrap();
    read_metadata(&path, &decoded).unwrap()
}

fn campo<'a>(rows: &'a [(String, String)], k: &str) -> Option<&'a str> {
    rows.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
}

fn secao<'a>(m: &'a Metadata, id: &str) -> &'a [(String, String)] {
    &m.sections.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("sem aba {id}")).rows
}

#[test]
fn abas_por_formato_dos_arquivos_de_teste() {
    let jpg = meta("meta_gps.jpg");
    assert!(campo(secao(&jpg, "jfif"), "JFIF Version").is_some());
    assert_eq!(campo(secao(&jpg, "tiff"), "Make"), Some("Gera"));

    let png = meta("alpha.png");
    assert_eq!(campo(secao(&png, "png"), "Color Type"), Some("RGB + Alpha"));
    assert!(png.sections.iter().all(|s| s.id != "jfif" && s.id != "gif"));

    let gif = meta("anim.gif");
    assert_eq!(campo(secao(&gif, "gif"), "Frames"), Some("3"));

    let tiff = meta("multi.tiff");
    assert!(campo(secao(&tiff, "tiff"), "Compression").is_some() || !secao(&tiff, "tiff").is_empty());

    let avif = meta("img.avif");
    assert_eq!(campo(secao(&avif, "heif"), "Major Brand"), Some("avif"));
}

#[test]
fn texts_do_arquivo_vem_do_iptc_quando_nao_ha_xmp() {
    let m = meta("meta_iptc.jpg");
    assert_eq!(m.texts.title.as_deref(), Some("Praia"));
}

fn gradiente(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 90]))
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
    }
}

fn iim(v: &[(u8, &str)]) -> Vec<u8> {
    let mut o = Vec::new();
    for (n, t) in v {
        o.extend_from_slice(&[0x1C, 2, *n]);
        o.extend_from_slice(&(t.len() as u16).to_be_bytes());
        o.extend_from_slice(t.as_bytes());
    }
    o
}

const XMP: &str = "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"4\"><dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Título XMP</rdf:li></rdf:Alt></dc:title><dc:subject><rdf:Bag><rdf:li>mar</rdf:li><rdf:li>sol</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";

/// Escreve `fmt` com EXIF (fixture do GPS), ICC, IPTC e XMP e devolve o caminho.
fn fonte(dir: &Path, fmt: ExportFormat, ext: &str) -> std::path::PathBuf {
    let exif = {
        let d = decode(&ensure_fixtures().join("meta_gps.jpg")).unwrap();
        d.exif.expect("EXIF da fixture")
    };
    let meta = MetaCarry {
        exif: Some(exif),
        icc: Some(icc_profile_named("Perfil Teste")),
        iptc: Some(iim(&[(5, "Praia"), (25, "mar"), (25, "sol"), (116, "Gera")])),
        xmp: Some(XMP.to_string()),
        ..MetaCarry::default()
    };
    let rgba = DynamicImage::ImageRgb8(gradiente(40, 20)).into_rgba8();
    let path = dir.join(format!("fonte.{ext}"));
    fs::write(&path, encode(&rgba, &opts(fmt), &meta).unwrap()).unwrap();
    path
}

fn edicao() -> MetadataEdits {
    MetadataEdits {
        title: Some("Novo título & <teste>".into()),
        description: Some("Linha 1\nLinha 2".into()),
        author: Some("Ana".into()),
        alt_text: Some("Um gato na praia".into()),
    }
}

fn salva_com_edicao(dir_nome: &str, fmt: ExportFormat, ext: &str) -> (Metadata, std::path::PathBuf) {
    let dir = tmp(dir_nome);
    let path = fonte(&dir, fmt, ext);
    let store = DocStore::new();
    let info = store.open_documents(&[s(&path)]).remove(0);
    assert_eq!(info.error, None);
    store.wait_ready(info.id).unwrap();
    // Uma operação para o documento ficar sujo como num uso real (o Salvar grava de qualquer jeito).
    store
        .apply_op(info.id, Op::Crop(CropSpec::from(Rect { x: 0, y: 0, w: 30, h: 16 })))
        .unwrap();
    store.set_meta_edits(info.id, &edicao());
    assert!(matches!(store.save(info.id, None).unwrap(), SaveOutcome::Saved(_)));
    let d = decode(&path).unwrap();
    (read_metadata(&path, &d).unwrap(), path)
}

fn confere_textos(m: &Metadata) {
    assert_eq!(m.texts.title.as_deref(), Some("Novo título & <teste>"));
    assert_eq!(m.texts.description.as_deref(), Some("Linha 1\nLinha 2"));
    assert_eq!(m.texts.author.as_deref(), Some("Ana"));
    assert_eq!(m.texts.alt_text.as_deref(), Some("Um gato na praia"));
}

#[test]
fn jpeg_salvar_grava_textos_e_preserva_exif_icc_iptc_xmp() {
    let (m, path) = salva_com_edicao("insp-jpeg", ExportFormat::Jpeg, "jpg");
    confere_textos(&m);
    assert_eq!(m.general.profile.as_deref(), Some("Perfil Teste"));
    assert!(campo(&m.exif, "Make").unwrap().contains("Gera"));
    assert!(m.gps.is_some());
    assert_eq!(m.keywords, vec!["mar".to_string(), "sol".to_string()]); // XMP e IPTC mantidos
    assert_eq!(campo(&m.iptc, "Copyright"), Some("Gera"));
    let bytes = fs::read(&path).unwrap();
    let xmp = formatinfo_xmp(&bytes);
    assert!(xmp.contains("xmp:Rating=\"4\""), "{xmp}");
    assert_eq!((m.general.width, m.general.height), (30, 16));
}

#[test]
fn tiff_salvar_grava_textos_e_preserva_exif_icc_iptc_xmp() {
    let (m, _) = salva_com_edicao("insp-tiff", ExportFormat::Tiff, "tiff");
    confere_textos(&m);
    assert_eq!(m.general.profile.as_deref(), Some("Perfil Teste"));
    assert!(campo(&m.exif, "Make").unwrap().contains("Gera"));
    assert_eq!(m.keywords, vec!["mar".to_string(), "sol".to_string()]);
    assert_eq!(campo(&m.iptc, "Copyright"), Some("Gera"));
}

#[test]
fn png_salvar_grava_textos_no_xmp_e_preserva_o_resto_do_xmp() {
    let (m, path) = salva_com_edicao("insp-png", ExportFormat::Png, "png");
    confere_textos(&m);
    assert_eq!(m.keywords, vec!["mar".to_string(), "sol".to_string()]);
    assert!(formatinfo_xmp(&fs::read(&path).unwrap()).contains("xmp:Rating=\"4\""));
}

#[test]
fn edicao_vazia_apaga_o_campo_e_none_mantem() {
    let dir = tmp("insp-apaga");
    let path = fonte(&dir, ExportFormat::Jpeg, "jpg");
    let store = DocStore::new();
    let id: DocId = store.open_documents(&[s(&path)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.apply_op(id, Op::FlipH).unwrap();
    store.set_meta_edits(id, &MetadataEdits { title: Some(String::new()), ..Default::default() });
    store.save(id, None).unwrap();
    let d = decode(&path).unwrap();
    let m = read_metadata(&path, &d).unwrap();
    assert_eq!(m.texts.title, None, "título apagado do XMP e do IPTC");
    assert_eq!(m.keywords.len(), 2);
}

/// XMP cru do arquivo.
fn formatinfo_xmp(bytes: &[u8]) -> String {
    gera_view_image_lib::image::metadata::file_iim_xmp(bytes).1.expect("XMP")
}

// ---------- arquivos truncados e adulterados ----------

/// Gerador pseudoaleatório fixo (xorshift): o mesmo ataque em toda execução.
fn xorshift(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

#[test]
fn leitura_de_metadados_nao_panica_com_arquivos_truncados_ou_adulterados() {
    let dir = ensure_fixtures();
    let originais = ["meta_gps.jpg", "meta_iptc.jpg", "alpha.png", "anim.gif", "multi.tiff", "img.avif"];
    let mut st = 0x9E37_79B9_7F4A_7C15u64;
    for nome in originais {
        let orig = fs::read(dir.join(nome)).unwrap();
        let exif = decode(&dir.join(nome)).ok().and_then(|d| d.exif);
        // truncamentos
        for n in (0..orig.len().min(600)).chain((600..orig.len()).step_by(37)) {
            let _ = formatinfo::sections(&orig[..n], exif.as_deref());
            let _ = parse_blocks(&orig[..n], exif.as_deref());
        }
        // bytes trocados (cabeçalhos e metadados ficam no começo)
        for _ in 0..400 {
            let mut b = orig.clone();
            for _ in 0..1 + xorshift(&mut st) % 6 {
                let i = (xorshift(&mut st) as usize) % b.len().min(1024);
                b[i] = xorshift(&mut st) as u8;
            }
            let _ = formatinfo::sections(&b, exif.as_deref());
            let _ = parse_blocks(&b, exif.as_deref());
        }
        // o próprio EXIF adulterado alimenta MakerNote, lente e TIFF
        if let Some(e) = &exif {
            for _ in 0..300 {
                let mut x = e.clone();
                for _ in 0..1 + xorshift(&mut st) % 6 {
                    let i = (xorshift(&mut st) as usize) % x.len();
                    x[i] = xorshift(&mut st) as u8;
                }
                let _ = parse_blocks(&orig, Some(&x));
                let _ = formatinfo::sections(&orig, Some(&x));
            }
        }
    }
}

#[test]
fn makernote_forjado_dentro_de_um_exif_valido_nao_panica() {
    // EXIF little-endian com Make "Canon" e um MakerNote cujo IFD declara 65535 entradas.
    let make = b"Canon\0";
    let mut mn = vec![0xFF, 0xFF];
    mn.extend(std::iter::repeat_n(0xAB, 64));
    let ifd0_len = 2 + 12 * 2 + 4;
    let make_off = 8 + ifd0_len;
    let mn_off = make_off + make.len();
    let mut t = b"II*\0\x08\0\0\0".to_vec();
    t.extend_from_slice(&2u16.to_le_bytes());
    for (tag, ty, count, off) in [
        (0x010Fu16, 2u16, make.len() as u32, make_off as u32),
        (0x927C, 7, mn.len() as u32, mn_off as u32),
    ] {
        t.extend_from_slice(&tag.to_le_bytes());
        t.extend_from_slice(&ty.to_le_bytes());
        t.extend_from_slice(&count.to_le_bytes());
        t.extend_from_slice(&off.to_le_bytes());
    }
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(make);
    t.extend_from_slice(&mn);
    let b = parse_blocks(b"x", Some(&t));
    assert!(b.exif.iter().any(|(k, _)| k == "Make"), "o EXIF em si é lido");
    assert!(b.maker.is_none(), "MakerNote lixo não vira aba");
}
