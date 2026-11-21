//! Lote 9 (Inspetor completo): editar título, descrição, autor e texto alternativo.
//! Stub do Lote 0: devolve `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{doc::model::DocId, error::AppResult};
use serde::Deserialize;

/// Campos editados no Inspetor (`None` = manter o do arquivo); gravados no próximo Salvar.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEdits {
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    /// Descrição da Imagem (texto alternativo).
    pub alt_text: Option<String>,
}

#[tauri::command]
pub fn edit_metadata(id: DocId, edits: MetadataEdits) -> AppResult<()> {
    not_yet("edit_metadata")
}
