//! Abrir, fechar e listar documentos.
use super::{blocking, log_timing, window};
use crate::{
    doc::{
        model::{DocId, DocInfo},
        store::DocStore,
        windows::{MAIN_WINDOW, WindowRegistry},
    },
    error::AppResult,
    image::decode,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use tauri::{State, WebviewWindow};

#[tauri::command]
pub async fn open_documents(
    window: WebviewWindow,
    store: State<'_, DocStore>,
    paths: Vec<String>,
) -> AppResult<Vec<DocInfo>> {
    let store = store.inner().clone();
    let infos = blocking(move || Ok(store.open_documents(&paths))).await?;
    window::claimed(&window, infos)
}

#[tauri::command]
pub async fn close_document(
    store: State<'_, DocStore>,
    registry: State<'_, WindowRegistry>,
    id: DocId,
) -> AppResult<()> {
    store.close(id)?;
    registry.forget(id);
    Ok(())
}

#[tauri::command]
pub async fn folder_images(path: String) -> AppResult<Vec<String>> {
    blocking(move || decode::folder_images(&PathBuf::from(path))).await
}

/// Arquivos de `argv[1..]`, abertos numa thread enquanto a janela e o WebView sobem.
#[derive(Clone, Default)]
pub struct Startup {
    job: Arc<Mutex<Option<JoinHandle<Vec<DocInfo>>>>>,
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

/// `DocInfo` atuais dos documentos da janela, em ordem de abertura: os de `argv` na principal
/// (espera a abertura terminar) e, se a página recarregar, os que ela já tinha.
#[tauri::command]
pub async fn startup_documents(
    window: WebviewWindow,
    store: State<'_, DocStore>,
    startup: State<'_, Startup>,
    registry: State<'_, WindowRegistry>,
) -> AppResult<Vec<DocInfo>> {
    if window.label() == MAIN_WINDOW {
        let startup = startup.inner().clone();
        let infos = blocking(move || {
            let job = startup.job.lock().unwrap_or_else(|e| e.into_inner()).take();
            Ok(job.and_then(|j| j.join().ok()).unwrap_or_default())
        })
        .await?;
        window::claimed(&window, infos)?;
    }
    Ok(registry.owned(window.label()).into_iter().filter_map(|id| store.info(id).ok()).collect())
}
