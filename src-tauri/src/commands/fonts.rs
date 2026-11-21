//! Lote 10 (Marcação extra): fontes do sistema para o painel Fontes.
//! Stub do Lote 0: devolve `AppError::Unsupported` até o lote implementar.
use super::not_yet;
use crate::error::AppResult;

/// Famílias instaladas, sem repetição e em ordem alfabética.
#[tauri::command]
pub fn system_fonts() -> AppResult<Vec<String>> {
    not_yet("system_fonts")
}
