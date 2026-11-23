//! Atualização ao vivo do tema: sinal `SettingChanged` do portal + monitoramento de
//! `kwinrc`, `kdeglobals` e do banco do dconf (gsettings), com debounce de 200 ms.
use super::detect::{SystemEnv, WindowTheme, config_home, detect_window_theme};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use zbus::zvariant::Value;

pub const EVENT: &str = "window-theme-changed";
pub const DEBOUNCE: Duration = Duration::from_millis(200);

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const PORTAL_IFACE: &str = "org.freedesktop.portal.Settings";
/// Limite por chamada ao portal: sem ele o zbus espera a resposta para sempre (portal ativado
/// pelo barramento que nunca responde), e a detecção de tema nunca termina.
const PORTAL_TIMEOUT: Duration = Duration::from_secs(2);

/// Proxy do `org.freedesktop.portal.Settings` numa conexão de sessão limitada a `PORTAL_TIMEOUT`.
fn portal_proxy() -> Option<zbus::blocking::Proxy<'static>> {
    let conn = zbus::blocking::connection::Builder::session()
        .ok()?
        .method_timeout(PORTAL_TIMEOUT)
        .build()
        .ok()?;
    zbus::blocking::Proxy::new_owned(conn, PORTAL_DEST, PORTAL_PATH, PORTAL_IFACE).ok()
}

/// Lê `org.freedesktop.appearance <key>` do portal (desembrulha variantes aninhadas).
pub fn portal_read(key: &str) -> Option<Value<'static>> {
    let proxy = portal_proxy()?;
    let args = ("org.freedesktop.appearance", key);
    let msg = proxy
        .call_method("ReadOne", &args)
        .or_else(|_| proxy.call_method("Read", &args))
        .ok()?;
    let mut v: Value<'static> = msg.body().deserialize::<zbus::zvariant::OwnedValue>().ok()?.into();
    while let Value::Value(inner) = v {
        v = *inner;
    }
    Some(v)
}

/// Agrupa rajadas de pulsos: chama `fire` uma vez após `window` sem novos pulsos.
pub fn debounce(rx: &Receiver<()>, window: Duration, mut fire: impl FnMut()) {
    while rx.recv().is_ok() {
        loop {
            match rx.recv_timeout(window) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    fire();
                    return;
                }
            }
        }
        fire();
    }
}

fn is_watched(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("kwinrc") || n.starts_with("kdeglobals") || n == "user")
}

/// Observa os diretórios dados (não recursivo; o KDE grava por rename atômico) e envia um pulso
/// quando `kwinrc`, `kdeglobals` ou o banco `user` do dconf mudam.
pub fn watch_config_files(dirs: &[PathBuf], tx: Sender<()>) -> notify::Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res
            && ev.paths.iter().any(|p| is_watched(p))
        {
            let _ = tx.send(());
        }
    })?;
    for d in dirs {
        if d.is_dir() {
            watcher.watch(d, RecursiveMode::NonRecursive)?;
        }
    }
    Ok(watcher)
}

fn spawn_portal_listener(tx: Sender<()>) {
    std::thread::spawn(move || {
        let Some(proxy) = portal_proxy() else { return };
        let Ok(signals) = proxy.receive_signal("SettingChanged") else { return };
        for _ in signals {
            if tx.send(()).is_err() {
                return;
            }
        }
    });
}

/// Inicia o monitoramento; emite `window-theme-changed` só quando o tema detectado muda.
pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    spawn_portal_listener(tx.clone());
    let cfg = config_home(&SystemEnv);
    let dirs = [cfg.clone(), cfg.join("dconf")];
    std::thread::spawn(move || {
        // o watcher precisa viver tanto quanto a thread
        let _watcher = watch_config_files(&dirs, tx).ok();
        let mut last: Option<WindowTheme> = Some(detect_window_theme(&SystemEnv));
        debounce(&rx, DEBOUNCE, || {
            let now = detect_window_theme(&SystemEnv);
            if last.as_ref() != Some(&now) {
                let _ = app.emit(EVENT, &now);
                last = Some(now);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn debounce_agrupa_rajada_em_um_disparo() {
        let (tx, rx) = mpsc::channel();
        for _ in 0..5 {
            tx.send(()).unwrap();
        }
        let h = std::thread::spawn(move || {
            let mut n = 0;
            debounce(&rx, Duration::from_millis(50), || n += 1);
            n
        });
        std::thread::sleep(Duration::from_millis(200));
        drop(tx);
        assert_eq!(h.join().unwrap(), 1);
    }

    #[test]
    fn debounce_dispara_de_novo_depois_do_silencio() {
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            let mut n = 0;
            debounce(&rx, Duration::from_millis(30), || n += 1);
            n
        });
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        drop(tx);
        assert_eq!(h.join().unwrap(), 2);
    }

    #[test]
    fn mudar_kwinrc_gera_pulso_e_outros_arquivos_nao() {
        let dir = std::env::temp_dir().join(format!("gvi-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = watch_config_files(std::slice::from_ref(&dir), tx).unwrap();

        std::fs::write(dir.join("outro.txt"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "arquivo irrelevante não deve notificar");

        let t = Instant::now();
        std::fs::write(dir.join("kwinrc"), "[org.kde.kdecoration2]\nButtonsOnRight=X\n").unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok(), "kwinrc deve notificar");
        assert!(t.elapsed() < Duration::from_secs(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
