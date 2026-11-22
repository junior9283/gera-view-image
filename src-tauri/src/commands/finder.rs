//! Lote 5 (Finder no Linux): etiquetas, bloquear, lixo, versões e Salvar Como.
//! A lógica fica em `doc/finder.rs` e `doc/versions.rs`; aqui só a ponte com a interface.
//! Só aceitam o id de um documento aberto (a interface não passa caminhos arbitrários).
use super::blocking;
use crate::{
    doc::{model::DocId, model::DocInfo, store::DocStore, versions},
    error::AppResult,
    image::encode::ExportOptions,
};
use tauri::{State, ipc::Response};

pub use crate::doc::versions::FileVersion;

/// Etiquetas (`user.xdg.tags`).
#[tauri::command]
pub async fn file_tags(store: State<'_, DocStore>, id: DocId) -> AppResult<Vec<String>> {
    let store = store.inner().clone();
    blocking(move || store.file_tags(id)).await
}

/// Grava as etiquetas e devolve a lista como ficou (sem vazias nem repetidas).
#[tauri::command]
pub async fn set_file_tags(
    store: State<'_, DocStore>,
    id: DocId,
    tags: Vec<String>,
) -> AppResult<Vec<String>> {
    let store = store.inner().clone();
    blocking(move || store.set_file_tags(id, &tags)).await
}

/// O arquivo está bloqueado (sem permissão de escrita)?
#[tauri::command]
pub async fn file_locked(store: State<'_, DocStore>, id: DocId) -> AppResult<bool> {
    let store = store.inner().clone();
    blocking(move || store.file_locked(id)).await
}

/// Bloquear = sem permissão de escrita; o Salvar passa a ir para Exportar.
#[tauri::command]
pub async fn set_locked(store: State<'_, DocStore>, id: DocId, locked: bool) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.set_locked(id, locked)).await
}

/// Move o arquivo para o Lixo (nunca apaga). A interface fecha o documento depois.
#[tauri::command]
pub async fn move_to_trash(store: State<'_, DocStore>, id: DocId) -> AppResult<()> {
    let store = store.inner().clone();
    blocking(move || store.move_to_trash(id)).await
}

#[tauri::command]
pub async fn list_versions(store: State<'_, DocStore>, id: DocId) -> AppResult<Vec<FileVersion>> {
    let store = store.inner().clone();
    blocking(move || store.list_versions(id)).await
}

/// Prévia da versão (formato de `render_view`).
#[tauri::command]
pub async fn version_preview(
    store: State<'_, DocStore>,
    id: DocId,
    version: String,
    size: u32,
) -> AppResult<Response> {
    let store = store.inner().clone();
    blocking(move || store.version_preview(id, &version, size.min(2048)))
        .await
        .map(Response::new)
}

/// A versão vira o conteúdo do documento, sem gravar (o Salvar grava).
#[tauri::command]
pub async fn restore_version(
    store: State<'_, DocStore>,
    id: DocId,
    version: String,
) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.restore_version(id, &version)).await
}

/// `prefs.versionsMaxMb`: espaço máximo das versões (0 desliga).
#[tauri::command]
pub fn set_versions_limit(mb: u32) {
    versions::set_max_bytes(u64::from(mb) << 20);
}

/// Salvar Como…: grava em `dest` e o documento passa a ser esse arquivo.
#[tauri::command]
pub async fn save_as(
    store: State<'_, DocStore>,
    id: DocId,
    dest: String,
    opts: ExportOptions,
    keywords: Option<Vec<String>>,
) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.save_as(id, &dest, &opts, keywords)).await
}
