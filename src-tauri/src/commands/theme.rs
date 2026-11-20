use crate::theme::detect::{SystemEnv, WindowTheme, detect_window_theme};

/// Tema atual da janela (botões, estilo, claro/escuro). Mudanças chegam pelo evento
/// `window-theme-changed`, com o mesmo payload.
#[tauri::command]
pub fn window_theme() -> WindowTheme {
    detect_window_theme(&SystemEnv)
}
