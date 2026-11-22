use crate::theme::detect::{SystemEnv, WindowTheme, detect_window_theme};
use gtk::prelude::*;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// Tema atual da janela (botões, estilo, claro/escuro). Mudanças chegam pelo evento
/// `window-theme-changed`, com o mesmo payload.
///
/// `async`: comando síncrono roda na thread principal do GTK, e a detecção consulta o portal
/// (D-Bus) e o `gsettings`. Com o portal travado, a janela inteira congelava (E2E no CI).
#[tauri::command(async)]
pub fn window_theme() -> WindowTheme {
    detect_window_theme(&SystemEnv)
}

/// Resultado da sonda de transparência, medido uma vez na inicialização (thread principal do GTK).
pub struct Compositing(pub bool);

/// A janela transparente precisa de compositor e visual RGBA. Se não der para saber, assume que sim.
pub fn probe_compositing(app: &AppHandle) -> bool {
    let Some(screen) = app
        .get_webview_window(crate::doc::windows::MAIN_WINDOW)
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

/// Pixels lógicos (px CSS) por polegada do monitor em que a janela está; `None` se o sistema não
/// informa o tamanho físico. Síncrono: fala com o GTK, na thread principal.
#[tauri::command]
pub fn screen_ppi(window: WebviewWindow) -> Option<f64> {
    let win = window.gtk_window().ok()?.window()?;
    let monitor = win.display().monitor_at_window(&win)?;
    ppi(monitor.geometry().width(), monitor.width_mm())
}

/// Densidade plausível de um monitor. TVs e projetores costumam informar um tamanho falso
/// (ex.: 16 x 9 mm): melhor nenhum que um errado.
fn ppi(px: i32, mm: i32) -> Option<f64> {
    if px <= 0 || mm <= 0 {
        return None;
    }
    let v = f64::from(px) * 25.4 / f64::from(mm);
    (40.0..=1000.0).contains(&v).then_some(v)
}

#[cfg(test)]
mod tests {
    use super::ppi;

    #[test]
    fn ppi_do_monitor() {
        // 24" Full HD (531 mm de largura): 91,8 px por polegada.
        assert!((ppi(1920, 531).unwrap() - 91.84).abs() < 0.01);
        // 16" 4K a 200%: a largura lógica é 1920.
        assert!((ppi(1920, 344).unwrap() - 141.77).abs() < 0.01);
    }

    #[test]
    fn ppi_sem_tamanho_ou_absurdo() {
        for (px, mm) in [(1920, 0), (1920, -1), (0, 500), (-5, 500), (1920, 16), (1920, 5000), (i32::MAX, 1)] {
            assert_eq!(ppi(px, mm), None, "{px} px / {mm} mm");
        }
    }
}
