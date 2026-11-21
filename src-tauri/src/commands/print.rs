//! Lote 11 (Exportar e Imprimir completos): Exportar como PDF e impressão nativa (GTK).
//! Stubs do Lote 0: devolvem `AppError::Unsupported` até o lote implementar. A impressão atual
//! (`print_document`, `print_image`...) continua em `file.rs`; o lote pode trazê-la para cá.
#![allow(unused_variables)]
use super::not_yet;
use crate::{doc::model::DocId, error::AppResult};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrintFit {
    /// Imprimir imagem inteira.
    Whole,
    /// Preencher o papel (corta o que sobrar).
    Fill,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOptions {
    pub copies: u32,
    /// Escala em %; `None` = usar `fit`.
    pub scale_percent: Option<u32>,
    pub fit: PrintFit,
    pub auto_rotate: bool,
    pub per_page: u32,
    pub show_markup: bool,
}

/// Uma página por imagem, na ordem de `ids`.
#[tauri::command]
pub fn export_pdf(ids: Vec<DocId>, dest: String) -> AppResult<()> {
    not_yet("export_pdf")
}

#[tauri::command]
pub fn print_native(ids: Vec<DocId>, opts: PrintOptions) -> AppResult<()> {
    not_yet("print_native")
}
