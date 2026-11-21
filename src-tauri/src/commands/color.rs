//! Lote 1 (Cor): correspondência de cor na exibição e Atribuir Perfil….
//! Stubs do Lote 0: devolvem `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{
    doc::model::{DocId, DocInfo},
    error::AppResult,
};
use serde::Serialize;

/// Perfil oferecido em Atribuir Perfil… (`id`: "srgb", "display-p3", "adobe-rgb" ou caminho de um .icc).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorProfile {
    pub id: String,
    pub name: String,
}

/// Descrição do perfil do monitor (colord); `None` = sRGB presumido.
#[tauri::command]
pub fn display_profile() -> AppResult<Option<String>> {
    not_yet("display_profile")
}

#[tauri::command]
pub fn list_profiles() -> AppResult<Vec<ColorProfile>> {
    not_yet("list_profiles")
}

#[tauri::command]
pub fn assign_profile(id: DocId, profile: String) -> AppResult<DocInfo> {
    not_yet("assign_profile")
}
