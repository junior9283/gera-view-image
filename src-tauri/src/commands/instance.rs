//! Instância única (`tauri-plugin-single-instance`, D-Bus `<identificador>.SingleInstance`):
//! abrir um arquivo com o app já aberto entrega os caminhos à instância que já roda, que os abre
//! numa janela dela (conforme Abrir arquivos) e a traz para a frente. Sem arquivos, só a traz.
//!
//! Os argumentos chegam de outro processo pelo barramento de sessão: são entrada não confiável.
use crate::{doc::windows::WindowRegistry, error::AppResult};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// Há caminhos para a janela abrir: ela os pega com `take_open_requests`.
pub const OPEN_EVENT: &str = "open-request";
/// Arquivos aceitos por pedido (o resto é ignorado).
pub const MAX_PATHS: usize = 1000;
/// Tamanho máximo de um argumento, em bytes (o `PATH_MAX` do Linux).
pub const MAX_ARG: usize = 4096;

/// Arquivos locais regulares existentes de `argv[1..]`, canônicos, sem repetição e na ordem dada.
/// Relativos são resolvidos em `cwd` (o da outra instância), que precisa ser absoluto. Opções
/// (`-x`, `--y`) e o resto que não é arquivo são ignorados, nunca interpretados.
pub fn requested_paths(argv: &[String], cwd: &str) -> Vec<String> {
    let cwd = Path::new(cwd);
    let mut out: Vec<String> = Vec::new();
    for arg in argv.iter().skip(1).take(MAX_PATHS) {
        if arg.is_empty() || arg.len() > MAX_ARG || arg.contains('\0') {
            continue;
        }
        let path = Path::new(arg);
        let path: PathBuf = if path.is_absolute() {
            path.into()
        } else if cwd.is_absolute() {
            cwd.join(path)
        } else {
            continue;
        };
        let Ok(real) = std::fs::canonicalize(&path) else {
            continue;
        };
        let regular = std::fs::metadata(&real).is_ok_and(|m| m.file_type().is_file());
        if let (true, Some(s)) = (regular, real.to_str())
            && !out.iter().any(|p| p == s)
        {
            out.push(s.to_string());
        }
    }
    out
}

/// Caminhos à espera de cada janela e a última que teve o foco.
#[derive(Default)]
pub struct OpenRequests {
    pending: Mutex<HashMap<String, Vec<String>>>,
    focused: Mutex<Option<String>>,
}

impl OpenRequests {
    pub fn focused(&self, label: &str) {
        *self.focused.lock().unwrap_or_else(|e| e.into_inner()) = Some(label.to_string());
    }

    /// Guarda os caminhos para `label`, sem passar do teto somado.
    pub fn push(&self, label: &str, paths: Vec<String>) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let list = pending.entry(label.to_string()).or_default();
        let room = MAX_PATHS.saturating_sub(list.len());
        list.extend(paths.into_iter().take(room));
    }

    pub fn take(&self, label: &str) -> Vec<String> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label)
            .unwrap_or_default()
    }

    /// A janela fechou: o que ela não pegou vai para `to` (se houver).
    pub fn forget(&self, label: &str, to: Option<&str>) {
        let left = self.take(label);
        if let Some(to) = to
            && !left.is_empty()
        {
            self.push(to, left);
        }
    }

    /// A janela que recebe: a última com foco, se ainda puder receber, ou a primeira que puder.
    pub fn target(&self, registry: &WindowRegistry) -> Option<String> {
        let ok = |l: &str| registry.check(l).is_ok() && !registry.is_sealed(l);
        let last = self
            .focused
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        last.filter(|l| ok(l))
            .or_else(|| registry.labels().into_iter().find(|l| ok(l)))
    }
}

/// Callback do plugin (roda na thread do D-Bus: o trabalho com disco vai para outra).
pub fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let app = app.clone();
    std::thread::spawn(move || deliver(&app, requested_paths(&argv, &cwd)));
}

fn deliver(app: &AppHandle, paths: Vec<String>) {
    let requests = app.state::<OpenRequests>();
    // Sem janela que possa receber (o app está saindo): nada a fazer.
    let Some(label) = requests.target(&app.state::<WindowRegistry>()) else {
        return;
    };
    super::window::raise(app, &label);
    if !paths.is_empty() {
        requests.push(&label, paths);
        let _ = app.emit_to(label, OPEN_EVENT, ());
    }
}

/// A janela foi destruída: o que ela não pegou vai para outra.
pub fn window_gone(app: &AppHandle, label: &str) {
    let requests = app.state::<OpenRequests>();
    let to = requests.target(&app.state::<WindowRegistry>());
    requests.forget(label, to.as_deref());
    if let Some(to) = to {
        let _ = app.emit_to(to, OPEN_EVENT, ());
    }
}

/// Caminhos pedidos por outra instância para esta janela (some da fila).
#[tauri::command]
pub async fn take_open_requests(
    window: WebviewWindow,
    requests: State<'_, OpenRequests>,
) -> AppResult<Vec<String>> {
    Ok(requests.take(window.label()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::windows::MAIN_WINDOW;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gvi-instance-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("gera-view-image")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn so_arquivos_regulares_canonicos() {
        let d = dir("filtro");
        let foto = d.join("Ação 1.jpg");
        std::fs::write(&foto, b"x").unwrap();
        std::fs::create_dir(d.join("pasta")).unwrap();
        std::os::unix::fs::symlink(&foto, d.join("link.jpg")).unwrap();
        std::fs::write(d.join("-x"), b"x").unwrap();
        let cwd = d.to_str().unwrap();
        let foto_s = foto.to_str().unwrap().to_string();
        let got = requested_paths(
            &args(&[
                "--new-window",
                "Ação 1.jpg",
                "pasta",
                "link.jpg",
                "sumiu.png",
                "",
                "/dev/null",
                "file:///etc/passwd",
                "a\0b",
                "../filtro/./Ação 1.jpg",
                "-x",
            ]),
            cwd,
        );
        assert_eq!(
            got,
            vec![foto_s.clone(), d.join("-x").to_str().unwrap().to_string()]
        );
        // Relativo sem cwd absoluto: ignorado; absoluto continua valendo.
        assert!(requested_paths(&args(&["Ação 1.jpg"]), "relativo").is_empty());
        assert_eq!(requested_paths(&args(&[&foto_s]), ""), vec![foto_s.clone()]);
        // argv[0] nunca é arquivo pedido.
        assert!(requested_paths(std::slice::from_ref(&foto_s), cwd).is_empty());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn tetos_de_quantidade_e_tamanho() {
        let d = dir("tetos");
        std::fs::write(d.join("a.png"), b"x").unwrap();
        let cwd = d.to_str().unwrap();
        let mut many = vec!["nada"; MAX_PATHS];
        many.push("a.png");
        assert!(
            requested_paths(&args(&many), cwd).is_empty(),
            "além do teto não é olhado"
        );
        let long = format!("{}/{}", "a".repeat(MAX_ARG), "a.png");
        assert!(requested_paths(&args(&[&long]), cwd).is_empty());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn fila_por_janela_com_teto_e_alvo() {
        let r = OpenRequests::default();
        r.push("main", vec!["/a".into(); MAX_PATHS - 1]);
        r.push("main", vec!["/b".into(), "/c".into()]);
        let got = r.take("main");
        assert_eq!(got.len(), MAX_PATHS);
        assert_eq!(got.last().map(String::as_str), Some("/b"));
        assert!(r.take("main").is_empty());

        let registry = WindowRegistry::default();
        assert_eq!(r.target(&registry).as_deref(), Some(MAIN_WINDOW));
        let other = registry.create();
        r.focused(&other);
        assert_eq!(r.target(&registry), Some(other.clone()));
        registry
            .seal(&other, crate::doc::windows::Seal::Close)
            .unwrap();
        assert_eq!(
            r.target(&registry).as_deref(),
            Some(MAIN_WINDOW),
            "selada não recebe"
        );
        r.push(&other, vec!["/x".into()]);
        r.forget(&other, Some(MAIN_WINDOW));
        assert_eq!(r.take(MAIN_WINDOW), vec!["/x".to_string()]);
    }
}
