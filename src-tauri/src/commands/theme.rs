use crate::theme::detect::{SystemEnv, WindowTheme, detect_window_theme};
use gtk::prelude::*;
use tauri::{AppHandle, Manager, State};

/// Tema atual da janela (botões, estilo, claro/escuro). Mudanças chegam pelo evento
/// `window-theme-changed`, com o mesmo payload.
#[tauri::command]
pub fn window_theme() -> WindowTheme {
    detect_window_theme(&SystemEnv)
}

/// Resultado da sonda de transparência, medido uma vez na inicialização (thread principal do GTK).
pub struct Compositing(pub bool);

/// A janela transparente precisa de compositor e visual RGBA. Se não der para saber, assume que sim.
pub fn probe_compositing(app: &AppHandle) -> bool {
    let Some(screen) = app
        .get_webview_window("main")
        .and_then(|w| w.gtk_window().ok())
        .and_then(|w| WidgetExt::screen(&w))
    else {
        return true;
    };
    screen.is_composited() && screen.rgba_visual().is_some()
}

/// `false` => o front cai na decoração nativa (spec §13.3).
#[tauri::command]
pub fn compositing_available(state: State<Compositing>) -> bool {
    state.0
}
