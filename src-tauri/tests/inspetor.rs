//! Inspetor completo (Lote 9): abas por formato, título/descrição/autor/texto alternativo gravados
//! no Salvar sem perder EXIF, ICC, IPTC e XMP, e arquivos truncados ou adulterados sem pânico.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    commands::describe::MetadataEdits,
    doc::{
        file::{RevertTarget, SaveOutcome},
        model::{DocId, Op, Rect, CropSpec},
        store::DocStore,
    },
    image::{
        container::{TiffMeta, exif_with_dpi, tiff_with_meta},
        decode::decode,
        encode::{ExportFormat, ExportOptions, MetaCarry, encode},
        formatinfo,
        metadata::{Metadata, parse_blocks, read_metadata, read_metadata_with},
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
    ExportOptions::new(format)
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

/// EXIF little-endian com Make, Artist, ImageDescription e XPAuthor (UTF-16).
fn exif_com_textos_antigos() -> Vec<u8> {
    let ascii = |s: &str| {
        let mut b = s.as_bytes().to_vec();
        b.push(0);
        (b.len() as u32, b)
    };
    let (n_xp, xp) = {
        let mut b: Vec<u8> = "Autor XP antigo".encode_utf16().flat_map(u16::to_le_bytes).collect();
        b.extend_from_slice(&[0, 0]);
        (b.len() as u32, b)
    };
    let entries = [
        (0x010Eu16, 2u16, ascii("Descricao antiga")),
        (0x010F, 2, ascii("Gera")),
        (0x013B, 2, ascii("Antigo Autor")),
        (0x9C9D, 1, (n_xp, xp)),
    ];
    let n = entries.len();
    let extra_at = 8 + 2 + 12 * n + 4;
    let mut out = b"II*\0\x08\0\0\0".to_vec();
    out.extend_from_slice(&(n as u16).to_le_bytes());
    let mut tail = Vec::new();
    for (tag, ty, (count, data)) in entries {
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&ty.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&((extra_at + tail.len()) as u32).to_le_bytes());
        tail.extend_from_slice(&data);
        if tail.len() % 2 == 1 {
            tail.push(0);
        }
    }
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&tail);
    out
}

fn contem(bytes: &[u8], s: &str) -> bool {
    let u: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
    bytes.windows(s.len()).any(|w| w == s.as_bytes()) || bytes.windows(u.len()).any(|w| w == u)
}

#[test]
fn editar_autor_e_descricao_nao_deixa_o_valor_antigo_no_exif() {
    // (os campos de texto vão para XMP/IPTC; o EXIF perde os antigos)
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let meta = MetaCarry {
        exif: Some(exif_com_textos_antigos()),
        icc: Some(icc_profile_named("Perfil Teste")),
        iptc: Some(iim(&[(25, "mar"), (25, "sol"), (116, "Gera")])),
        xmp: Some(XMP.to_string()),
        text_edits: Some(edicao_autor_e_descricao()),
        exif_cleared: Some(edicao_autor_e_descricao()),
        ..MetaCarry::default()
    };
    for (fmt, ext) in [(ExportFormat::Jpeg, "jpg"), (ExportFormat::Tiff, "tiff"), (ExportFormat::Png, "png")] {
        let out = encode(&rgba, &opts(fmt), &meta).unwrap();
        for velho in ["Antigo Autor", "Descricao antiga", "Autor XP antigo"] {
            assert!(!contem(&out, velho), "{velho} sobrou no .{ext}");
        }
        if ext != "png" {
            let dir = tmp(&format!("insp-exif-{ext}"));
            let path = dir.join(format!("a.{ext}"));
            fs::write(&path, &out).unwrap();
            let d = decode(&path).unwrap();
            let m = read_metadata(&path, &d).unwrap();
            assert!(campo(&m.exif, "Make").unwrap().contains("Gera"), ".{ext} perdeu o Make");
            assert_eq!(m.texts.author.as_deref(), Some("Ana"));
            assert_eq!(m.general.profile.as_deref(), Some("Perfil Teste"));
            assert_eq!(campo(&m.iptc, "Copyright"), Some("Gera"));
            assert_eq!(m.keywords, vec!["mar".to_string(), "sol".to_string()]);
        }
    }
}

fn edicao_autor_e_descricao() -> MetadataEdits {
    MetadataEdits {
        author: Some("Ana".into()),
        description: Some(String::new()),
        ..Default::default()
    }
}

/// JPEG de 16x8 com o EXIF de `exif_com_textos_antigos`.
fn jpeg_com_exif_antigo(dir: &Path) -> std::path::PathBuf {
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let meta = MetaCarry {
        exif: Some(exif_com_textos_antigos()),
        icc: Some(icc_profile_named("Perfil Teste")),
        ..MetaCarry::default()
    };
    let path = dir.join("origem.jpg");
    fs::write(&path, encode(&rgba, &opts(ExportFormat::Jpeg), &meta).unwrap()).unwrap();
    path
}

fn sem_texto_antigo(path: &Path, onde: &str) {
    let bytes = fs::read(path).unwrap();
    for velho in ["Antigo Autor", "Descricao antiga", "Autor XP antigo"] {
        assert!(!contem(&bytes, velho), "{velho} voltou em {onde}");
    }
}

#[test]
fn texto_apagado_nao_volta_ao_exif_em_salvar_exportar_salvar_como_e_duplicar() {
    let dir = tmp("insp-ciclo");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &edicao_autor_e_descricao());
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::Saved(_)));
    sem_texto_antigo(&src, "1º Salvar");

    // O front limpa as edições depois de salvar; o EXIF de origem do documento continua com o antigo.
    store.set_meta_edits(id, &MetadataEdits::default());
    store.apply_op(id, Op::FlipH).unwrap();
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::Saved(_)));
    sem_texto_antigo(&src, "2º Salvar");

    // A aba também não mostra o valor antigo.
    let source = store.with_doc(id, |d| d.source.clone()).unwrap();
    let m = read_metadata_with(&src, &source, &store.meta_cleared(id)).unwrap();
    assert_eq!(m.texts.author.as_deref(), Some("Ana"));
    assert_eq!(m.texts.description, None);
    assert!(campo(&m.exif, "Make").unwrap().contains("Gera"));
    let sem = read_metadata(&src, &source).unwrap();
    // sem a limpeza, a leitura ainda enxerga o EXIF antigo guardado na abertura
    assert!(campo(&sem.exif, "Artist").is_some());

    let fora = dir.join("exportado.jpg");
    store.export(id, &s(&fora), &opts(ExportFormat::Jpeg), None).unwrap();
    sem_texto_antigo(&fora, "Exportar");

    let como = dir.join("como.jpg");
    store.save_as(id, &s(&como), &opts(ExportFormat::Jpeg), None).unwrap();
    sem_texto_antigo(&como, "Salvar Como");

    let dup = store.duplicate(id, "copia").unwrap().id;
    let dup_fora = dir.join("dup.jpg");
    store.export(dup, &s(&dup_fora), &opts(ExportFormat::Jpeg), None).unwrap();
    sem_texto_antigo(&dup_fora, "Duplicar");
}

#[test]
fn reverter_descarta_so_a_pendencia_e_mantem_o_que_ja_foi_gravado() {
    let dir = tmp("insp-reverter");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &edicao_autor_e_descricao());
    store.save(id, None).unwrap();
    assert!(!store.meta_cleared(id).is_empty());
    store.set_meta_edits(id, &MetadataEdits { title: Some("pendente".into()), ..Default::default() });
    store.revert(id, RevertTarget::Original).unwrap();
    // O EXIF da abertura continua com o texto antigo: os marcadores ficam para limpá-lo de novo.
    assert!(!store.meta_cleared(id).is_empty());
    assert_eq!(store.meta_edits(id), None);
    let fora = dir.join("depois-de-reverter.jpg");
    store.export(id, &s(&fora), &opts(ExportFormat::Jpeg), None).unwrap();
    sem_texto_antigo(&fora, "Exportar depois de Reverter");
    store.close(id).unwrap();
    assert!(store.meta_cleared(id).is_empty());
}

/// O PSD leva XMP e IPTC: o autor novo vai neles e o antigo sai do EXIF.
#[test]
fn psd_exportado_leva_o_texto_novo_e_nao_o_antigo() {
    let dir = tmp("insp-psd");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &edicao_autor_e_descricao());
    let psd = dir.join("a.psd");
    store.export(id, &s(&psd), &opts(ExportFormat::Psd), None).unwrap();
    let bytes = std::fs::read(&psd).unwrap();
    assert!(!contem(&bytes, "Antigo Autor") && !contem(&bytes, "Descricao antiga"));
    assert!(contem(&bytes, &edicao_autor_e_descricao().author.unwrap()));
    assert!(store.take_meta_notes(id).is_empty());
}

/// AVIF não guarda texto novo, mas apagar já valeu no arquivo: a cópia não pode trazer o antigo.
#[test]
fn apagar_e_gravar_em_avif_vira_marcador() {
    let dir = tmp("insp-avif-marcador");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &MetadataEdits { author: Some(String::new()), title: Some("novo".into()), ..Default::default() });
    store.meta_written(id, false);
    let c = store.meta_cleared(id);
    assert_eq!((c.author.as_deref(), c.title), (Some(""), None));
    assert_eq!(store.meta_edits(id).and_then(|e| e.title).as_deref(), Some("novo"), "o texto novo segue pendente");
}

/// Restaurar uma versão troca a origem dos pixels, mas Reverter ao Original volta à da abertura:
/// os marcadores dela têm de voltar junto.
#[test]
fn reverter_ao_original_depois_de_trocar_a_origem_nao_traz_o_texto_de_volta() {
    let dir = tmp("insp-restaurar");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &edicao_autor_e_descricao());
    store.save(id, None).unwrap();
    store.revert(id, RevertTarget::LastSaved).unwrap();
    assert!(store.meta_cleared(id).is_empty(), "a origem agora é a do disco, já limpa");
    store.revert(id, RevertTarget::Original).unwrap();
    assert!(!store.meta_cleared(id).is_empty());
    let fora = dir.join("depois.jpg");
    store.export(id, &s(&fora), &opts(ExportFormat::Jpeg), None).unwrap();
    sem_texto_antigo(&fora, "Exportar depois de voltar à origem da abertura");
}

#[test]
fn avif_e_heic_so_apagam_e_o_novo_texto_fica_pendente() {
    let dir = tmp("insp-avif");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &edicao_autor_e_descricao()); // autor novo, descrição apagada
    let avif = dir.join("a.avif");
    store.export(id, &s(&avif), &opts(ExportFormat::Avif), None).unwrap();
    let exif = decode(&avif).unwrap().exif.expect("EXIF no AVIF");
    assert!(!contem(&exif, "Descricao antiga"), "apagar vale em qualquer formato");
    assert!(!contem(&exif, "Comentario"), "XPComment");
    assert!(contem(&exif, "Antigo Autor"), "AVIF não guarda o autor novo: o antigo fica, com a pendência");
    assert!(store.meta_edits(id).is_some(), "a edição segue pendente");
    // exportar para outro arquivo não marca nada como gravado no documento
    assert!(store.meta_cleared(id).is_empty());
}

#[test]
fn exif_ilegivel_com_edicao_pendente_e_descartado_em_vez_de_vazar() {
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let mut exif = exif_com_textos_antigos();
    exif[8..10].copy_from_slice(&u16::MAX.to_le_bytes()); // tabela do IFD0 forjada
    let meta = MetaCarry {
        exif: Some(exif),
        text_edits: Some(edicao_autor_e_descricao()),
        exif_cleared: Some(edicao_autor_e_descricao()),
        ..MetaCarry::default()
    };
    let out = encode(&rgba, &opts(ExportFormat::Jpeg), &meta).unwrap();
    assert!(!contem(&out, "Antigo Autor") && !contem(&out, "Descricao antiga"));
}

#[test]
fn autor_ja_apagado_nao_volta_ao_exif_do_avif_quando_ha_autor_novo_pendente() {
    let dir = tmp("insp-avif-marcador");
    let src = jpeg_com_exif_antigo(&dir);
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    // 1º: apaga o autor e grava no arquivo (vira marcador).
    store.set_meta_edits(id, &MetadataEdits { author: Some(String::new()), ..Default::default() });
    store.save(id, None).unwrap();
    // 2º: digita um autor novo (pendente) e exporta em AVIF, que não guarda o texto novo.
    store.set_meta_edits(id, &MetadataEdits { author: Some("Ana".into()), ..Default::default() });
    let avif = dir.join("b.avif");
    store.export(id, &s(&avif), &opts(ExportFormat::Avif), None).unwrap();
    let exif = decode(&avif).unwrap().exif.expect("EXIF no AVIF");
    assert!(!contem(&exif, "Antigo Autor") && !contem(&exif, "Autor XP antigo"), "o autor apagado voltou");
    assert_eq!(store.take_meta_notes(id), ["textNotSaved"]);
    assert!(store.take_meta_notes(id).is_empty(), "os avisos saem uma vez só");
}

#[test]
fn edicao_que_cai_no_pacote_novo_leva_os_textos_conhecidos_e_avisa() {
    let dir = tmp("insp-pacote-novo");
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let mut exif = exif_com_textos_antigos();
    exif[8..10].copy_from_slice(&u16::MAX.to_le_bytes()); // EXIF que não dá para limpar
    let meta = MetaCarry {
        iptc: Some(iim(&[(120, "Legenda conhecida"), (116, "Gera")])),
        xmp: Some("<<isto não é XML".into()),
        ..MetaCarry::default()
    };
    // O EXIF forjado vai direto no APP1: o app não grava um EXIF que não consegue limpar.
    let jpeg = encode(&rgba, &opts(ExportFormat::Jpeg), &meta).unwrap();
    let app1 = [b"Exif\0\0".as_slice(), &exif].concat();
    let len = ((app1.len() + 2) as u16).to_be_bytes();
    let src = dir.join("origem.jpg");
    fs::write(&src, [&jpeg[..2], &[0xFF, 0xE1, len[0], len[1]], &app1, &jpeg[2..]].concat()).unwrap();
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    store.set_meta_edits(id, &MetadataEdits { title: Some("Novo título".into()), ..Default::default() });
    store.save(id, None).unwrap();
    let d = decode(&src).unwrap();
    let m = read_metadata(&src, &d).unwrap();
    assert_eq!(m.texts.title.as_deref(), Some("Novo título"));
    assert_eq!(m.texts.description.as_deref(), Some("Legenda conhecida"), "o texto não editado foi semeado");
    assert_eq!(m.general.width, 16);
    // O EXIF não podia ser limpo: não é gravado (e o texto antigo dele não vaza), com aviso.
    assert_eq!(store.take_meta_notes(id), ["xmpRebuilt", "exifDropped"]);
    assert!(d.exif.is_none());
}

const TEXTOS_ANTIGOS: [&str; 3] = ["Antigo Autor", "Descricao antiga", "Autor XP antigo"];

/// Gravar com outra resolução não pode deixar uma cópia morta dos textos no EXIF: apagados numa
/// gravação seguinte, eles continuariam nos bytes.
#[test]
fn resolucao_nova_nao_deixa_copia_dos_textos_no_exif() {
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    for (fmt, ext) in [(ExportFormat::Jpeg, "jpg"), (ExportFormat::Png, "png"), (ExportFormat::Webp, "webp")] {
        let meta = MetaCarry { exif: Some(exif_com_textos_antigos()), ..MetaCarry::default() };
        let com_dpi = ExportOptions { dpi: Some(300.0), ..opts(fmt) };
        let path = tmp(&format!("insp-dpi-{ext}")).join(format!("a.{ext}"));
        fs::write(&path, encode(&rgba, &com_dpi, &meta).unwrap()).unwrap();
        let exif = decode(&path).unwrap().exif.expect("EXIF");
        for velho in TEXTOS_ANTIGOS {
            assert!(contem(&exif, velho), "{velho}: o ppp não apaga textos");
        }
        let limpo = MetaCarry { exif: Some(exif), exif_cleared: Some(edicao_autor_e_descricao()), ..MetaCarry::default() };
        let out = encode(&rgba, &opts(fmt), &limpo).unwrap();
        for velho in TEXTOS_ANTIGOS {
            assert!(!contem(&out, velho), "{velho} sobrou no .{ext}");
        }
        fs::write(&path, &out).unwrap();
        let d = decode(&path).unwrap();
        let m = read_metadata(&path, &d).unwrap();
        assert!(campo(&m.exif, "Make").unwrap().contains("Gera"), ".{ext} perdeu o Make");
    }
    // A resolução entra de fato, uma vez só por bloco.
    let uma = exif_with_dpi(Some(&exif_com_textos_antigos()), 300.0).unwrap();
    let duas = exif_with_dpi(Some(&uma), 72.0).unwrap();
    let r = exif::Reader::new().read_raw(duas).unwrap();
    let x = r.get_field(exif::Tag::XResolution, exif::In::PRIMARY).unwrap();
    assert!(matches!(&x.value, exif::Value::Rational(v) if v[0].to_f64() == 72.0));
}

/// Arquivo gravado por uma versão antiga do app, já com a cópia morta: apagar também a limpa.
#[test]
fn copia_morta_de_versoes_antigas_tambem_e_apagada() {
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let dpi = TiffMeta { dpi: Some((300.0, 300.0)), ..TiffMeta::default() };
    let antigo = tiff_with_meta(&exif_com_textos_antigos(), &dpi).unwrap();
    let meta = MetaCarry { exif: Some(antigo), exif_cleared: Some(edicao_autor_e_descricao()), ..MetaCarry::default() };
    let out = encode(&rgba, &opts(ExportFormat::Jpeg), &meta).unwrap();
    for velho in TEXTOS_ANTIGOS {
        assert!(!contem(&out, velho), "{velho} sobrou");
    }
    let path = tmp("insp-morta").join("a.jpg");
    fs::write(&path, &out).unwrap();
    let d = decode(&path).unwrap();
    assert!(campo(&read_metadata(&path, &d).unwrap().exif, "Make").unwrap().contains("Gera"));
}

#[test]
fn exif_que_nao_cabe_no_jpeg_avisa() {
    let dir = tmp("insp-exif-grande");
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let mut exif = exif_com_textos_antigos();
    exif.resize(70_000, 0);
    let meta = MetaCarry { exif: Some(exif), ..MetaCarry::default() };
    let src = dir.join("a.png");
    fs::write(&src, encode(&rgba, &opts(ExportFormat::Png), &meta).unwrap()).unwrap();
    let store = DocStore::new();
    let id = store.open_documents(&[s(&src)]).remove(0).id;
    store.wait_ready(id).unwrap();
    let grava = |o: ExportOptions, ext: &str| {
        store.export(id, &s(&dir.join(format!("b.{ext}"))), &o, None).unwrap();
        store.take_meta_notes(id)
    };
    assert_eq!(grava(opts(ExportFormat::Jpeg), "jpg"), ["exifTooBig"]);
    assert!(decode(&dir.join("b.jpg")).unwrap().exif.is_none());
    assert!(grava(opts(ExportFormat::Webp), "webp").is_empty());
    let sem = ExportOptions { strip_metadata: true, ..opts(ExportFormat::Jpeg) };
    assert!(grava(sem, "jpg").is_empty(), "remover metadados é uma escolha");
}

/// O que uma gravação levaria, para o aviso de perda antes de gravar.
#[test]
fn metadados_dizem_que_blocos_o_arquivo_tem() {
    let tem = |m: Metadata| (m.carried.exif, m.carried.text);
    assert_eq!(tem(meta("meta_gps.jpg")), (true, false));
    assert!(tem(meta("meta_iptc.jpg")).1);
    assert_eq!(tem(meta("alpha.png")), (false, false));
    let dir = tmp("insp-levados");
    for (fmt, ext) in [(ExportFormat::Png, "png"), (ExportFormat::Tiff, "tiff"), (ExportFormat::Psd, "psd")] {
        let path = fonte(&dir, fmt, ext);
        let d = decode(&path).unwrap();
        assert!(tem(read_metadata(&path, &d).unwrap()).1, ".{ext}");
    }
    // AVIF com XMP (que o app não lê nem regrava): também conta.
    let avif = dir.join("x.avif");
    let mut b = fs::read(ensure_fixtures().join("img.avif")).unwrap();
    b.extend(XMP.as_bytes());
    fs::write(&avif, b).unwrap();
    let d = decode(&avif).unwrap();
    assert!(tem(read_metadata(&avif, &d).unwrap()).1);
}

/// EXIF de `exif_com_textos_antigos` com um IFD1 e a miniatura do original (bytes reconhecíveis).
fn exif_com_miniatura() -> Vec<u8> {
    let mut e = exif_com_textos_antigos();
    let next_slot = 8 + 2 + 12 * 4;
    if e.len() % 2 == 1 {
        e.push(0);
    }
    let ifd1 = e.len() as u32;
    e[next_slot..next_slot + 4].copy_from_slice(&ifd1.to_le_bytes());
    let thumb_at = ifd1 + 2 + 24 + 4;
    e.extend(2u16.to_le_bytes());
    for (tag, v) in [(0x0201u16, thumb_at), (0x0202, MINIATURA.len() as u32)] {
        e.extend(tag.to_le_bytes());
        e.extend(4u16.to_le_bytes());
        e.extend(1u32.to_le_bytes());
        e.extend(v.to_le_bytes());
    }
    e.extend(0u32.to_le_bytes());
    e.extend(MINIATURA);
    e
}

const MINIATURA: &[u8] = b"\xFF\xD8MINIATURA-DO-ORIGINAL-ANTES-DO-RECORTE\xFF\xD9";

/// A miniatura embutida mostra a imagem de antes das edições: não vai para o arquivo gravado.
#[test]
fn miniatura_antiga_do_exif_nao_e_gravada() {
    let rgba = DynamicImage::ImageRgb8(gradiente(16, 8)).into_rgba8();
    let tem = |b: &[u8]| b.windows(MINIATURA.len()).any(|w| w == MINIATURA);
    let base = MetaCarry { exif: Some(exif_com_miniatura()), ..MetaCarry::default() };
    let texto = MetaCarry { exif_cleared: Some(edicao_autor_e_descricao()), ..base.clone() };
    for (fmt, ext) in [(ExportFormat::Jpeg, "jpg"), (ExportFormat::Tiff, "tiff"), (ExportFormat::Png, "png"), (ExportFormat::Webp, "webp")] {
        for (meta, dpi) in [(&base, None), (&base, Some(300.0)), (&texto, None), (&texto, Some(300.0))] {
            let o = ExportOptions { dpi, ..opts(fmt) };
            let out = encode(&rgba, &o, meta).unwrap();
            assert!(!tem(&out), ".{ext} com ppp {dpi:?}");
            let path = tmp(&format!("insp-mini-{ext}")).join(format!("a.{ext}"));
            fs::write(&path, &out).unwrap();
            let d = decode(&path).unwrap();
            assert!(campo(&read_metadata(&path, &d).unwrap().exif, "Make").unwrap().contains("Gera"), ".{ext}");
        }
    }
}
