//! Comandos de arquivo: salvar, exportar, reverter, renomear/mover, duplicar, abrir com,
//! imprimir e o vigia de alterações externas (`doc-changed-on-disk`).
use super::blocking;
use crate::{
    doc::{
        file::{RevertTarget, SaveOutcome, render_png},
        model::{DocId, DocInfo},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::encode::ExportOptions,
};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    ipc::Response,
};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn save(
    store: State<'_, DocStore>,
    id: DocId,
    keywords: Option<Vec<String>>,
) -> AppResult<SaveOutcome> {
    let store = store.inner().clone();
    blocking(move || store.save(id, keywords)).await
}

#[tauri::command]
pub async fn export(
    store: State<'_, DocStore>,
    id: DocId,
    dest: String,
    opts: ExportOptions,
    keywords: Option<Vec<String>>,
) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || {
        store.export(id, &dest, &opts, keywords)?;
        store.info(id)
    })
    .await
}

#[tauri::command]
pub async fn estimate_size(
    store: State<'_, DocStore>,
    id: DocId,
    opts: ExportOptions,
) -> AppResult<u64> {
    let store = store.inner().clone();
    blocking(move || store.estimate_size(id, &opts)).await
}

/// Há codificador HEVC (libkvazaar carregada): sem ele o Exportar oculta HEIC.
#[tauri::command]
pub async fn heic_encoder_available() -> AppResult<bool> {
    blocking(|| Ok(crate::image::encode_heic::hevc_encoder_available())).await
}

#[tauri::command]
pub async fn revert(store: State<'_, DocStore>, id: DocId, to: RevertTarget) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.revert(id, to)).await
}

#[tauri::command]
pub async fn rename(store: State<'_, DocStore>, id: DocId, name: String) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.rename(id, &name)).await
}

#[tauri::command]
pub async fn move_to(store: State<'_, DocStore>, id: DocId, dir: String) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.move_to(id, &dir)).await
}

#[tauri::command]
pub async fn duplicate(store: State<'_, DocStore>, id: DocId, name: String) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.duplicate(id, &name)).await
}

/// Existe algo em `path`? (Exportar pergunta antes de substituir.)
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// DPI atual do documento (o do arquivo ou o do último Ajustar Tamanho).
#[tauri::command]
pub async fn document_dpi(store: State<'_, DocStore>, id: DocId) -> AppResult<Option<f32>> {
    Ok(store.current_dpi(id)?.map(|(x, _)| x))
}

fn doc_path(store: &DocStore, id: DocId) -> AppResult<String> {
    let path = store.info(id)?.path;
    if path.is_empty() {
        return Err(AppError::NotFound("documento sem arquivo".into()));
    }
    Ok(path)
}

/// "Ignorar" na faixa de alteração externa: o arquivo modificado passa a ser a referência,
/// e o próximo Salvar grava por cima dele (escolha explícita). Arquivo apagado continua
/// sem Salvar (nunca é recriado sem Exportar).
#[tauri::command]
pub async fn ignore_disk_change(store: State<'_, DocStore>, id: DocId) -> AppResult<()> {
    store.accept_disk(id)
}

/// Abrir com…: o portal OpenURI pergunta o aplicativo; sem portal, abre no aplicativo padrão.
/// Só aceita o id de um documento aberto (a interface não passa caminhos arbitrários).
#[tauri::command]
pub async fn open_with(app: AppHandle, store: State<'_, DocStore>, id: DocId) -> AppResult<()> {
    let path = doc_path(&store, id)?;
    let via_portal = {
        let path = path.clone();
        blocking(move || super::capture::portal_open_file(Path::new(&path))).await
    };
    if via_portal.is_ok() {
        return Ok(());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Mostrar na Pasta.
#[tauri::command]
pub async fn reveal(app: AppHandle, store: State<'_, DocStore>, id: DocId) -> AppResult<()> {
    let path = doc_path(&store, id)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| AppError::Io(e.to_string()))
}

// ---------- impressão ----------

/// PNG em resolução cheia aguardando a página `print.html`.
#[derive(Default)]
pub struct PrintJob(Mutex<Option<Vec<u8>>>);

pub const PRINT_WINDOW: &str = "print";

/// Imprimir: renderiza o documento em PNG e abre a página interna de impressão.
#[tauri::command]
pub async fn print_document(
    app: AppHandle,
    store: State<'_, DocStore>,
    job: State<'_, PrintJob>,
    id: DocId,
    title: String,
) -> AppResult<()> {
    let store = store.inner().clone();
    let png = blocking(move || render_png(&store, id)).await?;
    *job.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(png);
    if let Some(w) = app.get_webview_window(PRINT_WINDOW) {
        // Página já aberta: recarrega com a imagem nova.
        let _ = w.eval("location.reload()");
        return w.set_focus().map_err(|e| AppError::Io(e.to_string()));
    }
    WebviewWindowBuilder::new(&app, PRINT_WINDOW, WebviewUrl::App("print.html".into()))
        .title(title)
        .inner_size(720.0, 640.0)
        .build()
        .map(|_| ())
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Bytes do PNG a imprimir (lidos pela `print.html`).
#[tauri::command]
pub fn print_image(job: State<'_, PrintJob>) -> AppResult<Response> {
    job.0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .map(Response::new)
        .ok_or_else(|| AppError::NotFound("nada para imprimir".into()))
}

/// Abre o diálogo de impressão do sistema (GTK) para a página que chamou.
#[tauri::command]
pub fn print_page(window: WebviewWindow) -> AppResult<()> {
    window.print().map_err(|e| AppError::Io(e.to_string()))
}

/// Fecha a página de impressão e libera o PNG.
#[tauri::command]
pub fn print_close(window: WebviewWindow, job: State<'_, PrintJob>) -> AppResult<()> {
    *job.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    window.close().map_err(|e| AppError::Io(e.to_string()))
}

// ---------- vigia de alterações externas ----------

pub const CHANGED_EVENT: &str = "doc-changed-on-disk";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskChanged {
    pub id: DocId,
    pub removed: bool,
}

/// Observa as pastas dos documentos abertos (notify) e avisa a interface quando um arquivo
/// muda ou some por fora. Rajadas são agrupadas (300 ms); cada mudança é avisada uma vez.
pub fn start_watch(app: AppHandle, store: DocStore) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let Ok(mut watcher) =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        let _ = tx.send(p);
                    }
                }
            })
        else {
            return;
        };
        let mut dirs: HashSet<PathBuf> = HashSet::new();
        let mut reported: HashMap<DocId, bool> = HashMap::new();
        loop {
            let mut touched: HashSet<PathBuf> = HashSet::new();
            if let Ok(p) = rx.recv_timeout(Duration::from_secs(1)) {
                touched.insert(p);
                while let Ok(p) = rx.recv_timeout(Duration::from_millis(300)) {
                    touched.insert(p);
                }
            }
            let docs = store.watched_paths();
            // Mantém vigiadas exatamente as pastas dos documentos abertos.
            let want: HashSet<PathBuf> = docs
                .iter()
                .filter_map(|(_, p)| Path::new(p).parent().map(Path::to_path_buf))
                .collect();
            for d in dirs.difference(&want) {
                let _ = watcher.unwatch(d);
            }
            for d in want.difference(&dirs) {
                let _ = watcher.watch(d, RecursiveMode::NonRecursive);
            }
            dirs = want;
            reported.retain(|id, _| docs.iter().any(|(d, _)| d == id));
            for (id, path) in docs {
                if !touched.contains(Path::new(&path)) && !reported.contains_key(&id) {
                    continue;
                }
                match store.disk_change(id) {
                    Ok(Some(removed)) if reported.get(&id) != Some(&removed) => {
                        reported.insert(id, removed);
                        let _ = app.emit(CHANGED_EVENT, DiskChanged { id, removed });
                    }
                    Ok(None) => {
                        reported.remove(&id);
                    }
                    _ => {}
                }
            }
        }
    });
}
