//! Comandos de arquivo: salvar, exportar, reverter, renomear/mover, duplicar, abrir com,
//! e o vigia de alterações externas (`doc-changed-on-disk`).
use super::blocking;
use crate::{
    doc::{
        file::{RevertTarget, SaveOutcome},
        model::{DocId, DocInfo},
        store::DocStore,
        windows::WindowRegistry,
    },
    error::{AppError, AppResult},
    image::encode::ExportOptions,
};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
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
pub async fn duplicate(
    window: WebviewWindow,
    store: State<'_, DocStore>,
    id: DocId,
    name: String,
) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    let copy = blocking(move || store.duplicate(id, &name)).await?;
    super::window::claimed_one(&window, copy)
}

/// Existe algo em `path`? (Exportar pergunta antes de substituir.)
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// DPI atual da página do documento (o do arquivo ou o do último Ajustar Tamanho).
#[tauri::command]
pub async fn document_dpi(
    store: State<'_, DocStore>,
    id: DocId,
    frame: Option<u32>,
) -> AppResult<Option<f32>> {
    Ok(store.current_dpi(id, frame.unwrap_or(0))?.map(|(x, _)| x))
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

// ---------- vigia de alterações externas ----------

pub const CHANGED_EVENT: &str = "doc-changed-on-disk";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskChanged {
    pub id: DocId,
    pub removed: bool,
}

/// Avisos de alteração no disco: cada mudança é avisada uma vez à janela que tem o documento. Se ele
/// muda de janela, a nova também é avisada (o aviso pode ter cruzado com a mudança).
#[derive(Default)]
struct Reported(HashMap<DocId, (bool, Option<String>)>);

impl Reported {
    /// A quem avisar agora. Sem ninguém com o documento (ainda abrindo, ou mudando de janela), fica
    /// pendente.
    fn due(&mut self, id: DocId, removed: bool, holder: Option<String>) -> Option<String> {
        let told = (removed, holder.clone());
        if self.0.get(&id) == Some(&told) {
            return None;
        }
        self.0.insert(id, told);
        holder
    }

    /// Há uma mudança conhecida deste documento (avisada ou pendente)?
    fn knows(&self, id: DocId) -> bool {
        self.0.contains_key(&id)
    }

    fn forget(&mut self, id: DocId) {
        self.0.remove(&id);
    }

    fn keep_only(&mut self, docs: &[(DocId, String)]) {
        self.0.retain(|id, _| docs.iter().any(|(d, _)| d == id));
    }
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
        let mut reported = Reported::default();
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
            reported.keep_only(&docs);
            for (id, path) in docs {
                if !touched.contains(Path::new(&path)) && !reported.knows(id) {
                    continue;
                }
                match store.disk_change(id) {
                    Ok(Some(removed)) => {
                        let holder = app.state::<WindowRegistry>().holder(id);
                        if let Some(label) = reported.due(id, removed, holder) {
                            let _ = app.emit_to(label, CHANGED_EVENT, DiskChanged { id, removed });
                        }
                    }
                    Ok(None) => reported.forget(id),
                    Err(_) => {}
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mudanca_no_disco_nao_se_perde_com_o_documento_mudando_de_janela() {
        let id = DocId(1);
        let mut r = Reported::default();
        assert_eq!(r.due(id, false, None), None, "ninguém com ele ainda");
        assert!(r.knows(id), "fica pendente, sem precisar mudar de novo");
        assert_eq!(r.due(id, false, Some("main".into())).as_deref(), Some("main"));
        assert_eq!(r.due(id, false, Some("main".into())), None, "uma vez só");
        assert_eq!(r.due(id, true, Some("main".into())).as_deref(), Some("main"), "agora sumiu");
        // Movido: a janela nova também é avisada, só depois de o receber.
        assert_eq!(r.due(id, true, None), None);
        assert_eq!(r.due(id, true, Some("doc-1".into())).as_deref(), Some("doc-1"));
        r.forget(id);
        assert!(!r.knows(id));
        r.due(id, false, Some("main".into()));
        r.keep_only(&[(DocId(2), String::new())]);
        assert!(!r.knows(id), "documento fechado");
    }
}
