//! Lote 5 (Finder no Linux): etiquetas, bloquear, lixo, versões e Salvar Como.
//! Stubs do Lote 0: devolvem `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{
    doc::model::{DocId, DocInfo},
    error::AppResult,
    image::encode::ExportOptions,
};
use serde::Serialize;

/// Versão guardada de um arquivo (snapshot feito a cada Salvar).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub id: String,
    /// Data e hora em ISO 8601.
    pub saved_at: String,
    pub size: u64,
}

/// Etiquetas (`user.xdg.tags`).
#[tauri::command]
pub fn file_tags(id: DocId) -> AppResult<Vec<String>> {
    not_yet("file_tags")
}

#[tauri::command]
pub fn set_file_tags(id: DocId, tags: Vec<String>) -> AppResult<()> {
    not_yet("set_file_tags")
}

/// Bloquear = sem permissão de escrita; o documento passa a abrir só leitura.
#[tauri::command]
pub fn set_locked(id: DocId, locked: bool) -> AppResult<DocInfo> {
    not_yet("set_locked")
}

#[tauri::command]
pub fn move_to_trash(id: DocId) -> AppResult<()> {
    not_yet("move_to_trash")
}

#[tauri::command]
pub fn list_versions(id: DocId) -> AppResult<Vec<FileVersion>> {
    not_yet("list_versions")
}

#[tauri::command]
pub fn restore_version(id: DocId, version: String) -> AppResult<DocInfo> {
    not_yet("restore_version")
}

/// Salvar Como…: grava em `dest` e o documento passa a ser esse arquivo.
#[tauri::command]
pub fn save_as(id: DocId, dest: String, opts: ExportOptions) -> AppResult<DocInfo> {
    not_yet("save_as")
}
