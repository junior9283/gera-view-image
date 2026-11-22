//! Lote 10 (Marcação extra): consentimento da câmera para capturar a assinatura.
//!
//! O WebKitGTK só libera `getUserMedia` se o app responder ao sinal `permission-request` (o
//! Tauri não responde). O handler é instalado no setup do app e é a única barreira: a interface
//! só arma depois de um clique explícito do usuário e de uma confirmação própria. O armamento
//! vale para UM pedido de vídeo, por poucos segundos; todo o resto (áudio, captura de tela,
//! localização, notificações, pedido sem armamento) é negado. A propriedade
//! `enable-media-stream` do WebKit não é alterada.
use crate::error::AppResult;
use std::time::{Duration, Instant};

/// Quanto tempo o armamento vale até o `getUserMedia` chegar.
const TTL: Duration = Duration::from_secs(20);

/// Consentimento de uso único e com validade.
#[derive(Default)]
pub(crate) struct Consent {
    until: Option<Instant>,
}

impl Consent {
    pub(crate) fn arm(&mut self, now: Instant) {
        self.until = Some(now + TTL);
    }

    pub(crate) fn disarm(&mut self) {
        self.until = None;
    }

    /// Consome o armamento: vale uma vez só e só dentro da validade.
    pub(crate) fn take(&mut self, now: Instant) -> bool {
        self.until.take().is_some_and(|t| now <= t)
    }
}

/// Decide o pedido de mídia: só vídeo de câmera (nem áudio nem captura de tela), e só se armado. Um pedido recusado por ser
/// de áudio (ou sem vídeo) não gasta o armamento.
pub(crate) fn decide(consent: &mut Consent, video: bool, audio: bool, display: bool, now: Instant) -> bool {
    video && !audio && !display && consent.take(now)
}

#[cfg(target_os = "linux")]
mod webkit {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use tauri::{AppHandle, Manager};
    use webkit2gtk::{
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebView,
        WebViewExt,
        glib::{Cast, ObjectExt},
    };

    static CONSENT: Mutex<Consent> = Mutex::new(Consent { until: None });
    static HOOKED: AtomicBool = AtomicBool::new(false);

    /// Pedido de captura de tela/janela (`is-for-display-device`, só nas versões novas do WebKit).
    fn for_display(m: &UserMediaPermissionRequest) -> bool {
        m.find_property("is-for-display-device").is_some() && m.property::<bool>("is-for-display-device")
    }

    fn on_request(req: &webkit2gtk::PermissionRequest) -> bool {
        let allow = match req.downcast_ref::<UserMediaPermissionRequest>() {
            Some(m) => {
                let mut c = CONSENT.lock().unwrap_or_else(|e| e.into_inner());
                decide(&mut c, m.is_for_video_device(), m.is_for_audio_device(), for_display(m), Instant::now())
            }
            _ => false,
        };
        if allow {
            req.allow();
        } else {
            req.deny();
        }
        true
    }

    fn hook(view: &WebView) {
        if !HOOKED.swap(true, Ordering::SeqCst) {
            view.connect_permission_request(|_, req| on_request(req));
        }
    }

    /// Instala o handler de permissões no webview principal (uma vez, no setup do app). Sem ele o
    /// WebKitGTK nega tudo; com ele, só o pedido de vídeo armado passa.
    pub fn install(app: &AppHandle) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.with_webview(|w| hook(&w.inner()));
        }
    }

    pub fn allow(app: &AppHandle, allowed: bool) {
        {
            let mut c = CONSENT.lock().unwrap_or_else(|e| e.into_inner());
            if allowed {
                c.arm(Instant::now());
            } else {
                c.disarm();
            }
        }
        // Reforço: se o setup não achou a janela, instala agora (idempotente).
        if allowed && !HOOKED.load(Ordering::SeqCst) {
            install(app);
        }
    }
}

/// Instala a barreira de permissão da câmera. Chamado no `setup`, antes de qualquer uso.
pub fn install(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    webkit::install(app);
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

/// Arma (`true`) ou desarma (`false`) a câmera. A interface chama depois do clique de
/// consentimento, antes de `getUserMedia`, e de novo (`false`) ao parar a câmera.
#[tauri::command]
pub async fn camera_allow(app: tauri::AppHandle, allowed: bool) -> AppResult<()> {
    #[cfg(target_os = "linux")]
    webkit::allow(&app, allowed);
    #[cfg(not(target_os = "linux"))]
    let _ = (app, allowed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sem_armar_nega() {
        let mut c = Consent::default();
        assert!(!decide(&mut c, true, false, false, Instant::now()));
    }

    #[test]
    fn armado_libera_um_pedido_de_video() {
        let (mut c, t) = (Consent::default(), Instant::now());
        c.arm(t);
        assert!(decide(&mut c, true, false, false, t));
        assert!(!decide(&mut c, true, false, false, t), "o armamento vale uma vez só");
    }

    #[test]
    fn nunca_libera_audio_nem_pedido_sem_video() {
        let (mut c, t) = (Consent::default(), Instant::now());
        c.arm(t);
        assert!(!decide(&mut c, true, true, false, t));
        assert!(!decide(&mut c, false, false, false, t));
        assert!(decide(&mut c, true, false, false, t), "pedido recusado não gasta o armamento");
    }

    #[test]
    fn nunca_libera_captura_de_tela_e_nao_gasta_o_armamento() {
        let (mut c, t) = (Consent::default(), Instant::now());
        c.arm(t);
        assert!(!decide(&mut c, true, false, true, t));
        assert!(decide(&mut c, true, false, false, t));
    }

    #[test]
    fn armamento_expira_e_desarmar_cancela() {
        let (mut c, t) = (Consent::default(), Instant::now());
        c.arm(t);
        assert!(!decide(&mut c, true, false, false, t + TTL + Duration::from_secs(1)));
        c.arm(t);
        c.disarm();
        assert!(!decide(&mut c, true, false, false, t));
    }
}
