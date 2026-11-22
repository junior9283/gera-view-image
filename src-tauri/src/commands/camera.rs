//! Lote 10 (Marcação extra): consentimento da câmera para capturar a assinatura.
//!
//! O WebKitGTK só libera `getUserMedia` se o app responder ao sinal `permission-request` (o
//! Tauri não responde). O handler é instalado em cada janela ao criá-la e é a única barreira: a
//! interface só arma depois de um clique explícito do usuário e de uma confirmação própria. O
//! armamento vale para UM pedido de vídeo da MESMA janela, por poucos segundos; todo o resto
//! (áudio, captura de tela, localização, notificações, pedido sem armamento) é negado. A propriedade
//! `enable-media-stream` do WebKit não é alterada.
use crate::error::AppResult;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tauri::WebviewWindow;

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

/// Consentimentos por janela (rótulo): armar a câmera numa não libera a outra.
#[derive(Default)]
pub(crate) struct Consents(HashMap<String, Consent>);

impl Consents {
    pub(crate) fn of(&mut self, label: &str) -> &mut Consent {
        self.0.entry(label.to_string()).or_default()
    }

    pub(crate) fn forget(&mut self, label: &str) {
        self.0.remove(label);
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
    use std::{
        collections::HashSet,
        sync::{LazyLock, Mutex, MutexGuard},
    };
    use webkit2gtk::{
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
        glib::{Cast, translate::ToGlibPtr},
    };

    static CONSENTS: LazyLock<Mutex<Consents>> = LazyLock::new(Mutex::default);
    /// Janelas que já têm o handler.
    static HOOKED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

    fn consents() -> MutexGuard<'static, Consents> {
        CONSENTS.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn hooked() -> MutexGuard<'static, HashSet<String>> {
        HOOKED.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Pedido de captura de tela/janela. O wrapper Rust não expõe isso (e não é uma propriedade
    /// GObject): chama a função C `webkit_user_media_permission_is_for_display_device`
    /// (WebKitGTK 2.34 ou mais novo; o Tauri 2 já exige uma versão maior). Se a feature do
    /// webkit2gtk não estiver ligada, o código nem compila, em vez de falhar aberto.
    pub(super) fn for_display(m: &UserMediaPermissionRequest) -> bool {
        // SAFETY: `m` é um UserMediaPermissionRequest vivo; a função só lê o estado do pedido.
        unsafe { webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(m.to_glib_none().0) != 0 }
    }

    fn on_request(label: &str, req: &webkit2gtk::PermissionRequest) -> bool {
        let allow = match req.downcast_ref::<UserMediaPermissionRequest>() {
            Some(m) => decide(
                consents().of(label),
                m.is_for_video_device(),
                m.is_for_audio_device(),
                for_display(m),
                Instant::now(),
            ),
            _ => false,
        };
        if allow {
            req.allow();
        } else {
            req.deny();
        }
        true
    }

    /// Sem o handler o WebKitGTK nega tudo; com ele, só o pedido de vídeo armado nesta janela passa.
    pub fn install(window: &WebviewWindow) {
        let label = window.label().to_string();
        if !hooked().insert(label.clone()) {
            return;
        }
        let failed = label.clone();
        let installed = window.with_webview(move |w| {
            w.inner().connect_permission_request(move |_, req| on_request(&label, req));
        });
        if installed.is_err() {
            hooked().remove(&failed);
        }
    }

    pub fn allow(window: &WebviewWindow, allowed: bool) {
        if !allowed {
            consents().of(window.label()).disarm();
            return;
        }
        // Reforço: se a janela ainda não tem o handler, instala agora (idempotente).
        install(window);
        consents().of(window.label()).arm(Instant::now());
    }

    pub fn forget(label: &str) {
        consents().forget(label);
        hooked().remove(label);
    }
}

/// Instala a barreira de permissão da câmera na janela, ao criá-la, antes de qualquer uso.
pub fn install(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    webkit::install(window);
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// Janela destruída: o consentimento dela acaba junto.
pub fn forget(label: &str) {
    #[cfg(target_os = "linux")]
    webkit::forget(label);
    #[cfg(not(target_os = "linux"))]
    let _ = label;
}

/// Arma (`true`) ou desarma (`false`) a câmera na janela que chamou. A interface chama depois do
/// clique de consentimento, antes de `getUserMedia`, e de novo (`false`) ao parar a câmera.
#[tauri::command]
pub async fn camera_allow(window: WebviewWindow, allowed: bool) -> AppResult<()> {
    #[cfg(target_os = "linux")]
    webkit::allow(&window, allowed);
    #[cfg(not(target_os = "linux"))]
    let _ = (window, allowed);
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

    #[test]
    fn consentimento_vale_so_na_janela_que_o_deu() {
        let (mut c, t) = (Consents::default(), Instant::now());
        c.of("doc-1").arm(t);
        assert!(!decide(c.of("main"), true, false, false, t), "outra janela continua negada");
        assert!(decide(c.of("doc-1"), true, false, false, t));
    }

    #[test]
    fn janela_fechada_perde_o_consentimento() {
        let (mut c, t) = (Consents::default(), Instant::now());
        c.of("doc-1").arm(t);
        c.forget("doc-1");
        assert!(!decide(c.of("doc-1"), true, false, false, t));
    }

    /// Exercita a ligação real: o símbolo C que `for_display` chama existe na libwebkit2gtk
    /// instalada (carregada com `dlopen`, porque o binário de teste não a mantém no processo).
    /// Um pedido de captura de tela de verdade só existe com um webview e uma página pedindo
    /// `getDisplayMedia`; criar o objeto sem WebKit inicializado derruba o processo (SIGSEGV),
    /// então este teste não cobre o valor devolvido, só que o símbolo existe.
    #[cfg(target_os = "linux")]
    #[test]
    fn simbolo_de_captura_de_tela_existe_na_libwebkit() {
        let nome = c"webkit_user_media_permission_is_for_display_device";
        let achou = [c"libwebkit2gtk-4.1.so.0", c"libwebkit2gtk-4.0.so.37"].iter().any(|lib| {
            // SAFETY: nomes C válidos; só consulta a tabela de símbolos e fecha em seguida.
            unsafe {
                let h = libc::dlopen(lib.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
                let ok = !h.is_null() && !libc::dlsym(h, nome.as_ptr()).is_null();
                if !h.is_null() {
                    libc::dlclose(h);
                }
                ok
            }
        });
        assert!(achou, "libwebkit2gtk sem is_for_display_device (precisa do WebKitGTK 2.34+)");
    }
}
