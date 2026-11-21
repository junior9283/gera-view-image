//! Lote 2 (Seleção e área de transferência): imagem da área de transferência para colar como camada.
//! Stub do Lote 0: devolve `AppError::Unsupported` até o lote implementar.
use super::not_yet;
use crate::error::AppResult;
use tauri::ipc::Response;

/// PNG da imagem na área de transferência (bytes crus), para virar anotação `image`.
#[tauri::command]
pub fn clipboard_image() -> AppResult<Response> {
    not_yet("clipboard_image")
}
