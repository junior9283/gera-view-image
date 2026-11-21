//! Lote 4 (Remover Fundo / Copiar Objeto): máscara do sujeito principal.
//! Stub do Lote 0: devolve `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{
    doc::model::{DocId, Mask},
    error::AppResult,
};

/// Máscara do sujeito; Remover Fundo aplica `Op::MakeTransparent` sobre o inverso dela.
#[tauri::command]
pub fn segment_subject(id: DocId) -> AppResult<Mask> {
    not_yet("segment_subject")
}
