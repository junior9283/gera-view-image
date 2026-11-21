//! Lote 3 (Texto ao Vivo): OCR, QR code e fala.
//! Stubs do Lote 0: devolvem `AppError::Unsupported` até o lote implementar.
#![allow(unused_variables)]
use super::not_yet;
use crate::{
    doc::model::{DocId, Rect},
    error::AppResult,
};
use serde::Serialize;

/// Palavra reconhecida, em px da imagem.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextWord {
    pub text: String,
    pub bbox: Rect,
}

/// Linha reconhecida, com as palavras na ordem de leitura.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub text: String,
    pub bbox: Rect,
    pub words: Vec<TextWord>,
}

/// QR code ou outro código lido na imagem.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCode {
    pub text: String,
    pub bbox: Rect,
}

#[tauri::command]
pub fn recognize_text(id: DocId, frame: u32) -> AppResult<Vec<TextLine>> {
    not_yet("recognize_text")
}

#[tauri::command]
pub fn detect_codes(id: DocId, frame: u32) -> AppResult<Vec<DetectedCode>> {
    not_yet("detect_codes")
}

/// Edição › Fala › Iniciar Fala (Speech Dispatcher, se instalado).
#[tauri::command]
pub fn speak(text: String) -> AppResult<()> {
    not_yet("speak")
}

#[tauri::command]
pub fn stop_speaking() -> AppResult<()> {
    not_yet("stop_speaking")
}
