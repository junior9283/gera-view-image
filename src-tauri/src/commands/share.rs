//! Lote 6 (Compartilhar): e-mail, KDE Connect e "Abrir com" com lista de apps.
//! Stubs do Lote 0: devolvem `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{doc::model::DocId, error::AppResult};
use serde::Serialize;

/// App que abre o tipo do arquivo (`id` = nome do .desktop).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

#[tauri::command]
pub fn share_email(ids: Vec<DocId>) -> AppResult<()> {
    not_yet("share_email")
}

#[tauri::command]
pub fn share_device(ids: Vec<DocId>) -> AppResult<()> {
    not_yet("share_device")
}

#[tauri::command]
pub fn open_with_apps(id: DocId) -> AppResult<Vec<AppEntry>> {
    not_yet("open_with_apps")
}

#[tauri::command]
pub fn open_with_app(id: DocId, app: String) -> AppResult<()> {
    not_yet("open_with_app")
}
