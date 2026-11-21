//! Lote 12 (Janelas e Abas): várias janelas e Importar do Scanner.
//! Stubs do Lote 0: devolvem `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{
    doc::model::{DocId, DocInfo},
    error::AppResult,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub label: String,
    pub title: String,
}

/// Abre uma janela com estes documentos (Mover Aba para Nova Janela); devolve o rótulo dela.
#[tauri::command]
pub fn new_window(ids: Vec<DocId>) -> AppResult<String> {
    not_yet("new_window")
}

#[tauri::command]
pub fn list_windows() -> AppResult<Vec<WindowEntry>> {
    not_yet("list_windows")
}

#[tauri::command]
pub fn focus_window(label: String) -> AppResult<()> {
    not_yet("focus_window")
}

/// Juntar Todas as Janelas: os documentos das outras vêm para esta, como abas.
#[tauri::command]
pub fn merge_windows(into: String) -> AppResult<()> {
    not_yet("merge_windows")
}

/// Importar do Scanner (SANE); `None` = cancelado.
#[tauri::command]
pub fn scan_image(name: String) -> AppResult<Option<DocInfo>> {
    not_yet("scan_image")
}
