//! Arquivo: salvar, exportar, reverter, renomear/mover e estimativa de tamanho (Task 11).
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::{
        file::{RevertTarget, SaveOutcome, copy_no_replace},
        model::{DocId, Op, ResizeFilter, SourceFormat},
        store::DocStore,
    },
    error::AppError,
    image::{
        decode::decode,
        encode::{ExportFormat, ExportOptions, MetaCarry, encode, write_atomic},
        metadata::parse_blocks,
    },
};
use image::{Rgb, RgbImage, RgbaImage};
use make_fixtures::{DIR_ACENTOS, ensure_fixtures, jpeg_bytes, s, tmp};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, path::PathBuf};

fn fx(name: &str) -> PathBuf {
    ensure_fixtures().join(name)
}

/// Copia a fixture para uma pasta temporária própria do teste.
fn copia(teste: &str, nome: &str) -> PathBuf {
    let dir = tmp(teste);
    let dest = dir.join(nome);
    fs::copy(fx(nome), &dest).unwrap();
    dest
}

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
    }
}

fn gradiente(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        Rgb([
            (x * 255 / w) as u8,
            (y * 255 / h) as u8,
            ((x + y) % 256) as u8,
        ])
    })
}

/// TIFF (LE) com Make, Model e Orientation.
fn exif_make_model_orientation(orientation: u16) -> Vec<u8> {
    let entry = |tag: u16, ty: u16, count: u32, val: [u8; 4]| {
        let mut e = tag.to_le_bytes().to_vec();
        e.extend_from_slice(&ty.to_le_bytes());
        e.extend_from_slice(&count.to_le_bytes());
        e.extend_from_slice(&val);
        e
    };
    let (make, model) = (b"Gera\0", b"TestCam\0");
    let off_make = 8 + 2 + 3 * 12 + 4;
    let off_model = off_make + make.len() as u32;
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
    let mut o = [0u8; 4];
    o[..2].copy_from_slice(&orientation.to_le_bytes());
    t.extend(entry(0x0112, 3, 1, o));
    t.extend_from_slice(&0u32.to_le_bytes());
    t.extend_from_slice(make);
    t.extend_from_slice(model);
    t
}

fn jpeg_com_exif(img: &RgbImage, tiff: &[u8]) -> Vec<u8> {
    let jpg = jpeg_bytes(img, 90);
    let payload = [b"Exif\0\0".as_slice(), tiff].concat();
    let mut out = jpg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpg[2..]);
    out
}

fn campo(blocks: &[(String, String)], nome: &str) -> Option<String> {
    blocks
        .iter()
        .find(|(k, _)| k == nome)
        .map(|(_, v)| v.clone())
}

#[test]
fn salvar_jpeg_preserva_exif_e_zera_orientacao() {
    let dir = tmp("salvar-exif");
    let path = dir.join("foto.jpg");
    // 40x20 com Orientation=6: aparece em pé (20x40).
    fs::write(
        &path,
        jpeg_com_exif(&gradiente(40, 20), &exif_make_model_orientation(6)),
    )
    .unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    assert_eq!(store.info(id).unwrap().width, 20);
    store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
    let out = store.save(id, None).unwrap();
    let SaveOutcome::Saved(info) = out else {
        panic!("JPEG deveria salvar no lugar")
    };
    assert!(!info.dirty);
    assert_eq!((info.width, info.height), (40, 20));

    let d = decode(&path).unwrap();
    assert_eq!(
        d.frames[0].dimensions(),
        (40, 20),
        "girado e com Orientation=1"
    );
    let bytes = fs::read(&path).unwrap();
    let b = parse_blocks(&bytes, d.exif.as_deref());
    assert_eq!(campo(&b.exif, "Make").as_deref(), Some("Gera"));
    assert_eq!(campo(&b.exif, "Model").as_deref(), Some("TestCam"));
    let orient = campo(&b.exif, "Orientation").unwrap_or_default();
    assert!(
        orient.contains("row 0 at top and column 0 at left") || orient == "1",
        "{orient}"
    );
}

#[test]
fn salvar_e_atomico() {
    let dir = tmp("atomico");
    let path = dir.join("orig.png");
    fs::write(&path, b"conteudo original").unwrap();
    let r = write_atomic(&path, |w| {
        use std::io::Write;
        w.write_all(b"parcial")?;
        Err(AppError::Corrupt("falha injetada no encode".into()))
    });
    assert!(r.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"conteudo original");
    let sobras: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path() != path)
        .collect();
    assert!(sobras.is_empty(), "temporário ficou para trás: {sobras:?}");
}

#[test]
fn salvar_preserva_permissoes() {
    let path = copia("permissoes", "alpha.png");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipH).unwrap();
    assert!(matches!(
        store.save(id, None).unwrap(),
        SaveOutcome::Saved(_)
    ));
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o640);
}

#[test]
fn salvar_raw_pede_exportar() {
    for nome in [
        "img.dng",
        "img.psd",
        "img.svg",
        "anim.gif",
        "multi.tiff",
        "img.heic",
    ] {
        let path = copia("raw-exportar", nome);
        let store = DocStore::new();
        let info = store.open_documents(&[s(&path)]).remove(0);
        if info.error.is_some() {
            continue; // HEIC sem libde265 nesta máquina
        }
        store.wait_ready(info.id).unwrap();
        assert!(!store.info(info.id).unwrap().writable, "{nome}");
        assert!(
            matches!(store.save(info.id, None).unwrap(), SaveOutcome::NeedsExport),
            "{nome}"
        );
    }
}

#[test]
fn salvar_em_caminho_com_acento() {
    let dir = tmp("acento").join(DIR_ACENTOS);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("Ação 1.jpg");
    fs::copy(fx(&format!("{DIR_ACENTOS}/Ação 1.jpg")), &path).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    let (w, h) = (
        store.info(id).unwrap().width,
        store.info(id).unwrap().height,
    );
    store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
    assert!(matches!(
        store.save(id, None).unwrap(),
        SaveOutcome::Saved(_)
    ));
    assert_eq!(decode(&path).unwrap().frames[0].dimensions(), (h, w));

    // Exportar para outro nome com acento e espaço.
    let dest = dir.join("Cópia com espaço.webp");
    store
        .export(id, &s(&dest), &opts(ExportFormat::Webp), None)
        .unwrap();
    assert_eq!(decode(&dest).unwrap().frames[0].dimensions(), (h, w));
}

#[test]
fn arquivo_removido_retorna_changed_on_disk() {
    let path = copia("removido", "alpha.png");
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipV).unwrap();
    fs::remove_file(&path).unwrap();
    let err = store.save(id, None).unwrap_err();
    assert_eq!(err.code(), "changed_on_disk");
    assert!(!path.exists(), "salvar não pode recriar o arquivo apagado");
    assert_eq!(store.disk_change(id).unwrap(), Some(true));
}

#[test]
fn arquivo_modificado_externamente_retorna_changed_on_disk() {
    let path = copia("modificado", "alpha.png");
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipV).unwrap();
    let outro = fs::read(fx("img.bmp")).unwrap();
    fs::write(&path, &outro).unwrap();
    let err = store.save(id, None).unwrap_err();
    assert_eq!(err.code(), "changed_on_disk");
    assert_eq!(
        fs::read(&path).unwrap(),
        outro,
        "não sobrescreve a versão de fora"
    );
    assert_eq!(store.disk_change(id).unwrap(), Some(false));

    // Reverter para o último salvo relê o disco e volta a permitir salvar.
    let info = store.revert(id, RevertTarget::LastSaved).unwrap();
    assert_eq!((info.width, info.height), (20, 10));
    assert_eq!(store.disk_change(id).unwrap(), None);
}

#[test]
fn reverter_para_o_original_mantem_a_abertura() {
    let path = copia("reverter", "rgb.jpg");
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
    store.save(id, None).unwrap();
    assert_eq!(store.info(id).unwrap().width, 40);
    let info = store.revert(id, RevertTarget::Original).unwrap();
    assert_eq!(
        (info.width, info.height),
        (20, 40),
        "volta ao estado da abertura"
    );
    assert!(
        info.dirty,
        "o disco tem a versão salva, diferente do original"
    );
    let info = store.revert(id, RevertTarget::LastSaved).unwrap();
    assert_eq!((info.width, info.height), (40, 20));
    assert!(!info.dirty);
}

#[test]
fn strip_metadata_remove_gps() {
    let store = DocStore::new();
    let id = abre(&store, &fx("meta_gps.jpg"));
    let dir = tmp("strip");
    let com = dir.join("com.jpg");
    let sem = dir.join("sem.jpg");
    store
        .export(id, &s(&com), &opts(ExportFormat::Jpeg), None)
        .unwrap();
    let mut o = opts(ExportFormat::Jpeg);
    o.strip_metadata = true;
    store.export(id, &s(&sem), &o, None).unwrap();

    let blocos = |p: &Path| {
        let d = decode(p).unwrap();
        parse_blocks(&fs::read(p).unwrap(), d.exif.as_deref())
    };
    assert!(blocos(&com).gps.is_some(), "sem strip, o GPS é preservado");
    let b = blocos(&sem);
    assert!(b.gps.is_none());
    assert!(b.exif.is_empty());
}

#[test]
fn palavras_chave_vao_para_iptc_e_xmp() {
    let path = copia("keywords", "meta_iptc.jpg");
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipH).unwrap();
    let kw = vec!["praia".to_string(), "férias".to_string()];
    store.save(id, Some(kw.clone())).unwrap();
    let d = decode(&path).unwrap();
    let b = parse_blocks(&fs::read(&path).unwrap(), d.exif.as_deref());
    assert_eq!(b.keywords, kw);
}

#[test]
fn exporta_cada_formato_e_reabre() {
    let store = DocStore::new();
    let id = abre(&store, &fx("alpha.png"));
    let dir = tmp("exporta-formatos");
    for (fmt, ext) in [
        (ExportFormat::Jpeg, "jpg"),
        (ExportFormat::Png, "png"),
        (ExportFormat::Tiff, "tiff"),
        (ExportFormat::Webp, "webp"),
        (ExportFormat::Avif, "avif"),
        (ExportFormat::Bmp, "bmp"),
        (ExportFormat::Exr, "exr"),
    ] {
        for (quality, depth16) in [(None, false), (Some(70), true)] {
            let dest = dir.join(format!("saida-{}.{ext}", quality.unwrap_or(0)));
            let mut o = opts(fmt);
            o.quality = quality;
            o.depth16 = depth16;
            o.resize = Some((15, 12));
            store.export(id, &s(&dest), &o, None).unwrap();
            let dims = if fmt == ExportFormat::Exr {
                image::image_dimensions(&dest).unwrap()
            } else if fmt == ExportFormat::Avif {
                imagesize::size(&dest)
                    .map(|s| (s.width as u32, s.height as u32))
                    .unwrap()
            } else {
                decode(&dest).unwrap().frames[0].dimensions()
            };
            assert_eq!(dims, (15, 12), "{fmt:?} q={quality:?}");
        }
    }
}

#[test]
fn formatos_sem_codificador_sao_recusados() {
    let img = RgbaImage::new(4, 4);
    for fmt in [ExportFormat::Heic, ExportFormat::Jp2] {
        let err = encode(&img, &opts(fmt), &MetaCarry::default()).unwrap_err();
        assert_eq!(err.code(), "unsupported", "{fmt:?}");
    }
}

#[test]
fn estimate_size_aproxima() {
    let store = DocStore::new();
    let path = tmp("estimativa").join("grande.png");
    let img = RgbaImage::from_fn(900, 700, |x, y| {
        image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x * y) % 256) as u8, 255])
    });
    img.save(&path).unwrap();
    let id = abre(&store, &path);
    for fmt in [ExportFormat::Jpeg, ExportFormat::Png, ExportFormat::Webp] {
        let o = opts(fmt);
        let est = store.estimate_size(id, &o).unwrap() as f64;
        let dest = path.with_extension(format!("{fmt:?}").to_lowercase());
        store.export(id, &s(&dest), &o, None).unwrap();
        let real = fs::metadata(&dest).unwrap().len() as f64;
        assert!(
            (est - real).abs() <= real * 0.10,
            "{fmt:?}: estimado {est}, real {real}"
        );
    }
}

#[test]
fn qualidade_jpeg_estimada_do_original() {
    use gera_view_image_lib::image::encode::jpeg_quality;
    for q in [50u8, 75, 90, 95] {
        let est = jpeg_quality(&jpeg_bytes(&gradiente(32, 32), q)).unwrap();
        assert!((est as i32 - q as i32).abs() <= 1, "q={q} estimada {est}");
    }
    assert_eq!(jpeg_quality(b"nada"), None);
}

#[test]
fn renomear_e_mover() {
    let path = copia("renomear", "alpha.png");
    let store = DocStore::new();
    let id = abre(&store, &path);
    let info = store.rename(id, "Nova ação.png").unwrap();
    let novo = path.with_file_name("Nova ação.png");
    assert_eq!(info.path, s(&novo));
    assert_eq!(info.name, "Nova ação.png");
    assert!(novo.exists() && !path.exists());
    // Não sobrescreve um arquivo existente.
    fs::write(path.with_file_name("ocupado.png"), b"x").unwrap();
    assert!(store.rename(id, "ocupado.png").is_err());
    assert!(store.rename(id, "../fora.png").is_err(), "nome sem barra");

    let destino = tmp("mover-destino");
    let info = store.move_to(id, &s(&destino)).unwrap();
    assert_eq!(info.path, s(&destino.join("Nova ação.png")));
    assert!(destino.join("Nova ação.png").exists() && !novo.exists());
    // Depois de mover, salvar continua funcionando (o carimbo do disco segue o arquivo).
    store.apply_op(id, Op::FlipH).unwrap();
    assert!(matches!(
        store.save(id, None).unwrap(),
        SaveOutcome::Saved(_)
    ));
}

#[test]
fn duplicar_abre_copia_sem_caminho() {
    let store = DocStore::new();
    let id = abre(&store, &fx("rgb.jpg"));
    store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
    let dup = store.duplicate(id, "rgb cópia.jpg").unwrap();
    assert_ne!(dup.id, id);
    assert_eq!(dup.path, "");
    assert!(!dup.writable);
    assert_eq!((dup.width, dup.height), (40, 20));
    assert!(matches!(
        store.save(dup.id, None).unwrap(),
        SaveOutcome::NeedsExport
    ));

    // Exportar um documento sem caminho o liga ao arquivo novo.
    let dest = tmp("duplicar").join("salvo.png");
    store
        .export(dup.id, &s(&dest), &opts(ExportFormat::Png), None)
        .unwrap();
    let info = store.info(dup.id).unwrap();
    assert_eq!(info.path, s(&dest));
    assert_eq!(info.format, SourceFormat::Png);
    assert!(info.writable && !info.dirty);
}

#[test]
fn dpi_do_documento_segue_o_redimensionar() {
    let store = DocStore::new();
    let id = abre(&store, &fx("alpha.png"));
    store
        .apply_op(
            id,
            Op::Resize {
                w: 10,
                h: 10,
                filter: ResizeFilter::Bilinear,
                dpi: Some(300.0),
            },
        )
        .unwrap();
    assert_eq!(store.current_dpi(id).unwrap(), Some((300.0, 300.0)));
    let dest = tmp("dpi").join("dpi.png");
    store
        .export(id, &s(&dest), &opts(ExportFormat::Png), None)
        .unwrap();
    let dpi = decode(&dest).unwrap().dpi.unwrap();
    assert!((dpi.0 - 300.0).abs() < 1.0, "{dpi:?}");
}

#[test]
fn copia_entre_discos_nao_abre_permissoes() {
    let dir = tmp("copia-perm");
    let from = dir.join("privado.png");
    fs::write(&from, b"segredo").unwrap();
    fs::set_permissions(&from, fs::Permissions::from_mode(0o600)).unwrap();
    let to = dir.join("cópia.png");
    copy_no_replace(&from, &to).unwrap();
    assert_eq!(
        fs::metadata(&to).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read(&to).unwrap(), b"segredo");
    // Não substitui um destino existente.
    let err = copy_no_replace(&from, &to).unwrap_err();
    assert_eq!(err.code(), "io");
}

#[test]
fn salvar_arquivo_privado_continua_privado() {
    let path = copia("privado", "alpha.png");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipH).unwrap();
    assert!(matches!(
        store.save(id, None).unwrap(),
        SaveOutcome::Saved(_)
    ));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
