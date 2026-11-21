//! Lote 7 (Barra lateral avançada): dados do arquivo para Ordenar Por.
//! Stub do Lote 0: devolve `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{doc::model::DocId, error::AppResult};
use serde::Serialize;

/// Data de modificação (ms desde 1970) e tamanho em disco; `None` sem arquivo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub id: DocId,
    pub modified_ms: Option<u64>,
    pub size: Option<u64>,
}

#[tauri::command]
pub fn file_stats(ids: Vec<DocId>) -> AppResult<Vec<FileStat>> {
    not_yet("file_stats")
}
