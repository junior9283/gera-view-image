//! Abrir, fechar e listar documentos.
use super::{blocking, log_timing};
use crate::{
    doc::{
        model::{DocId, DocInfo},
        store::DocStore,
    },
    error::AppResult,
    image::decode,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    thread::JoinHandle,
};
use tauri::State;

#[tauri::command]
pub async fn open_documents(
    store: State<'_, DocStore>,
    paths: Vec<String>,
) -> AppResult<Vec<DocInfo>> {
    let store = store.inner().clone();
    blocking(move || Ok(store.open_documents(&paths))).await
}

#[tauri::command]
pub async fn close_document(store: State<'_, DocStore>, id: DocId) -> AppResult<()> {
    store.close(id)
}

#[tauri::command]
pub async fn folder_images(path: String) -> AppResult<Vec<String>> {
    blocking(move || decode::folder_images(&PathBuf::from(path))).await
}

/// Arquivos de `argv[1..]`, abertos numa thread enquanto a janela e o WebView sobem.
#[derive(Clone, Default)]
pub struct Startup {
    job: Arc<Mutex<Option<JoinHandle<Vec<DocInfo>>>>>,
    ids: Arc<OnceLock<Vec<DocId>>>,
}

impl Startup {
    pub fn spawn(store: DocStore, paths: Vec<String>) -> Self {
        let job = (!paths.is_empty()).then(|| {
            std::thread::spawn(move || {
                let infos = store.open_documents(&paths);
                log_timing("documentos de argv abertos (prévia)");
                infos
            })
        });
        Startup {
            job: Arc::new(Mutex::new(job)),
            ids: Arc::default(),
        }
    }

    /// Caminhos absolutos dos argumentos que não são opções.
    /// Caminhos de `argv`, absolutos a partir de `cwd`. Um argumento que começa com `-`
    /// é opção (ignorada), a não ser que exista um arquivo com esse nome.
    pub fn paths_from_args(
        args: impl Iterator<Item = std::ffi::OsString>,
        cwd: &std::path::Path,
    ) -> Vec<String> {
        args.map(|a| {
            (
                a.to_string_lossy().starts_with('-'),
                cwd.join(PathBuf::from(a)),
            )
        })
        .filter(|(flag, p)| !flag || p.is_file())
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .collect()
    }
}

/// `DocInfo` atuais dos documentos de `argv` (espera a abertura terminar).
#[tauri::command]
pub async fn startup_documents(
    store: State<'_, DocStore>,
    startup: State<'_, Startup>,
) -> AppResult<Vec<DocInfo>> {
    let (store, startup) = (store.inner().clone(), startup.inner().clone());
    blocking(move || {
        let job = startup.job.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(job) = job {
            let infos = job.join().unwrap_or_default();
            let _ = startup.ids.set(infos.iter().map(|i| i.id).collect());
        }
        let ids = startup.ids.get().cloned().unwrap_or_default();
        Ok(ids
            .into_iter()
            .filter_map(|id| store.info(id).ok())
            .collect())
    })
    .await
}
