//! Lote 5 (Finder no Linux): versões a cada Salvar, restaurar, Salvar Como, bloquear e Lixo.
//! Binário próprio: configura a raiz das versões e o `XDG_DATA_HOME` (lixeira) do processo.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::{
        file::SaveOutcome,
        finder,
        model::{DocId, Op},
        store::DocStore,
        versions,
    },
    error::AppError,
    image::encode::{ExportFormat, ExportOptions, MetaCarry, encode},
};
use image::{Rgba, RgbaImage};
use make_fixtures::{png, s, tmp};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Once,
};

/// Raiz das versões e lixeira dentro da pasta temporária do processo (nunca a do usuário).
fn ambiente() -> PathBuf {
    static INIT: Once = Once::new();
    let base = tmp("finder-env");
    INIT.call_once(|| {
        // SAFETY: feito uma vez, antes de qualquer teste usar a lixeira ou as versões.
        unsafe { std::env::set_var("XDG_DATA_HOME", base.join("data")) };
        versions::configure(base.join("data/gera-view-image/versions"));
    });
    base
}

fn imagem(dir: &Path, nome: &str, cor: u8) -> PathBuf {
    let p = dir.join(nome);
    png(&p, &RgbaImage::from_pixel(8, 6, Rgba([cor, 0, 0, 255])));
    p
}

fn abre(store: &DocStore, path: &Path) -> DocId {
    let info = store.open_documents(&[s(path)]).remove(0);
    assert_eq!(info.error, None);
    store.wait_ready(info.id).unwrap();
    info.id
}

fn salva(store: &DocStore, id: DocId) {
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::Saved(_)));
}

#[test]
fn salvar_guarda_a_versao_anterior_e_restaurar_nao_grava() {
    ambiente();
    let dir = tmp("finder-versoes");
    let p = imagem(&dir, "foto.png", 10);
    let original = fs::read(&p).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &p);
    store.apply_op(id, Op::FlipH).unwrap();
    salva(&store, id);
    store.apply_op(id, Op::Rotate { quarter_turns: 1 }).unwrap();
    salva(&store, id);

    let list = store.list_versions(id).unwrap();
    assert_eq!(list.len(), 2, "uma versão por Salvar");
    let mais_antiga = &list[1];
    assert_eq!(mais_antiga.size, original.len() as u64);
    assert!(mais_antiga.saved_at.ends_with('Z'));

    let depois_do_salvar = fs::read(&p).unwrap();
    let info = store.restore_version(id, &mais_antiga.id).unwrap();
    assert!(info.dirty, "restaurar deixa o documento com alterações");
    assert_eq!((info.width, info.height), (8, 6));
    assert_eq!(fs::read(&p).unwrap(), depois_do_salvar, "restaurar não grava no arquivo");
    assert!(store.restore_version(id, "../../foto.png").is_err());

    let prev = store.version_preview(id, &mais_antiga.id, 4).unwrap();
    assert_eq!(&prev[..8], &[4, 0, 0, 0, 3, 0, 0, 0]);
}

/// A prévia da versão sai em cores de tela, como a miniatura da versão atual ao lado dela.
#[test]
fn previa_da_versao_converte_o_perfil() {
    ambiente();
    let dir = tmp("finder-versao-p3");
    let p = dir.join("p3.png");
    let opts = ExportOptions {
        format: ExportFormat::Png,
        quality: None,
        alpha: true,
        depth16: false,
        strip_metadata: false,
        resize: None,
        color_profile: Some("display-p3".into()),
    };
    let img = RgbaImage::from_pixel(8, 6, Rgba([215, 93, 31, 255]));
    fs::write(&p, encode(&img, &opts, &MetaCarry::default()).unwrap()).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &p);
    assert_ne!(store.render_full(id, 0).unwrap().get_pixel(0, 0).0, [215, 93, 31, 255]);
    store.apply_op(id, Op::FlipH).unwrap();
    salva(&store, id);
    let v = store.list_versions(id).unwrap().remove(0);
    let prev = store.version_preview(id, &v.id, 8).unwrap();
    assert!(prev[8..11].iter().zip([215, 93, 31]).all(|(a, b)| a.abs_diff(b) <= 2), "{:?}", &prev[8..12]);
    assert_eq!(prev, store.thumbnail(id, 0, 8).unwrap());
}

#[test]
fn salvar_como_passa_a_ser_o_arquivo_novo() {
    ambiente();
    let dir = tmp("finder-salvar-como");
    let p = imagem(&dir, "a.png", 20);
    let store = DocStore::new();
    let id = abre(&store, &p);
    store.apply_op(id, Op::FlipV).unwrap();
    let dest = dir.join("b.tiff");
    let opts = ExportOptions {
        format: ExportFormat::Tiff,
        quality: None,
        alpha: true,
        depth16: false,
        strip_metadata: false,
        resize: None,
        color_profile: None,
    };
    let info = store.save_as(id, &s(&dest), &opts, None).unwrap();
    assert_eq!(info.path, s(&dest));
    assert_eq!(info.name, "b.tiff");
    assert!(!info.dirty && info.writable);
    assert!(dest.exists() && p.exists());
    // Formato que o Salvar não regrava: recusa.
    let gif = ExportOptions { format: ExportFormat::Exr, ..opts };
    assert!(matches!(store.save_as(id, &s(&dir.join("c.exr")), &gif, None), Err(AppError::Unsupported(_))));
}

#[test]
fn bloquear_faz_o_salvar_ir_para_exportar() {
    ambiente();
    let dir = tmp("finder-bloquear");
    let p = imagem(&dir, "a.png", 30);
    let store = DocStore::new();
    let id = abre(&store, &p);
    let info = store.set_locked(id, true).unwrap();
    assert!(!info.writable);
    assert!(store.file_locked(id).unwrap());
    store.apply_op(id, Op::FlipH).unwrap();
    assert_eq!(store.save(id, None).unwrap(), SaveOutcome::NeedsExport);
    let info = store.set_locked(id, false).unwrap();
    assert!(info.writable);
    assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o200, 0o200);
}

#[test]
fn lixo_move_sem_apagar_e_symlink_vai_como_symlink() {
    let base = ambiente();
    let dir = tmp("finder-lixo");
    let p = imagem(&dir, "lixo.png", 40);
    let conteudo = fs::read(&p).unwrap();
    // Sem portal: a crate `trash` com a lixeira em XDG_DATA_HOME (temporária).
    finder::trash(&p, false).unwrap();
    assert!(!p.exists());
    let lixeira = base.join("data/Trash");
    let no_lixo = fs::read_dir(lixeira.join("files"))
        .unwrap()
        .flatten()
        .find(|e| e.file_name().to_string_lossy().starts_with("lixo.png"))
        .expect("arquivo no Lixo");
    assert_eq!(fs::read(no_lixo.path()).unwrap(), conteudo);
    let info = fs::read_dir(lixeira.join("info")).unwrap().flatten().find(|e| {
        e.file_name().to_string_lossy().starts_with("lixo.png")
    });
    let info = fs::read_to_string(info.expect(".trashinfo").path()).unwrap();
    assert!(info.starts_with("[Trash Info]") && info.contains("DeletionDate="));

    let alvo = imagem(&dir, "alvo.png", 50);
    let link = dir.join("atalho.png");
    std::os::unix::fs::symlink(&alvo, &link).unwrap();
    finder::trash(&link, true).unwrap();
    assert!(fs::symlink_metadata(&link).is_err());
    assert!(alvo.exists(), "o alvo do symlink fica");

    // Não existe: erro, nada é criado.
    assert!(finder::trash(&dir.join("nao-existe.png"), false).is_err());
}
