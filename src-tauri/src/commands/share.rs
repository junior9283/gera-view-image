//! Lote 6 (Compartilhar): e-mail, KDE Connect e "Abrir com" com lista de apps.
//!
//! Tudo que fala com D-Bus, subprocesso ou GIO roda em `blocking` (fora da thread do GTK) e com
//! prazo: o portal pela `method_timeout` da conexão, os subprocessos por `run_with_timeout`. Ver
//! `docs/testes/armadilhas.md` (portal travado congelava a janela).
use super::blocking;
use crate::{
    doc::{model::DocId, store::DocStore},
    error::{AppError, AppResult},
};
use gtk::gio::{self, prelude::*};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::OsStr,
    os::fd::AsFd,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tauri::State;
use zbus::zvariant::{Array, Fd, OwnedObjectPath, Value};

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
/// O `ComposeEmail` só devolve o handle do pedido: responde rápido quando o portal está vivo.
const PORTAL_TIMEOUT: Duration = Duration::from_secs(5);
/// `kdeconnect-cli` ativa o daemon pelo D-Bus na primeira chamada.
const KDECONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KDECONNECT: &str = "kdeconnect-cli";

/// App que abre o tipo do arquivo (`id` = nome do .desktop).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

/// Aparelho pareado e alcançável no KDE Connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
}

/// Caminhos dos documentos (todos precisam ter arquivo em disco).
fn doc_paths(store: &DocStore, ids: &[DocId]) -> AppResult<Vec<PathBuf>> {
    if ids.is_empty() {
        return Err(AppError::NotFound("nenhum documento".into()));
    }
    ids.iter()
        .map(|&id| {
            let path = store.info(id)?.path;
            if path.is_empty() {
                Err(AppError::NotFound("documento sem arquivo".into()))
            } else {
                Ok(PathBuf::from(path))
            }
        })
        .collect()
}

fn dbus_err(e: impl std::fmt::Display) -> AppError {
    AppError::Unsupported(format!("portal indisponível: {e}"))
}

/// E-mail: portal `org.freedesktop.portal.Email` com os arquivos anexados; sem portal,
/// `xdg-email --attach`.
#[tauri::command]
pub async fn share_email(store: State<'_, DocStore>, ids: Vec<DocId>) -> AppResult<()> {
    let paths = doc_paths(&store, &ids)?;
    blocking(move || portal_email(&paths).or_else(|_| xdg_email(&paths))).await
}

fn subject(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .filter_map(|p| p.file_name()?.to_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn portal_email(paths: &[PathBuf]) -> AppResult<()> {
    let files = paths
        .iter()
        .map(std::fs::File::open)
        .collect::<Result<Vec<_>, _>>()?;
    let conn = zbus::blocking::connection::Builder::session()
        .map_err(dbus_err)?
        .method_timeout(PORTAL_TIMEOUT)
        .build()
        .map_err(dbus_err)?;
    let proxy = zbus::blocking::Proxy::new(&conn, PORTAL_DEST, PORTAL_PATH, "org.freedesktop.portal.Email")
        .map_err(dbus_err)?;
    let fds: Vec<Fd> = files.iter().map(|f| Fd::from(f.as_fd())).collect();
    let mut opts: HashMap<&str, Value> = HashMap::new();
    opts.insert("subject", Value::from(subject(paths)));
    opts.insert("attachment_fds", Value::Array(Array::from(fds)));
    let _: OwnedObjectPath = proxy.call("ComposeEmail", &("", opts)).map_err(dbus_err)?;
    Ok(())
}

fn xdg_email(paths: &[PathBuf]) -> AppResult<()> {
    let mut cmd = Command::new("xdg-email");
    cmd.arg("--subject").arg(subject(paths));
    for p in paths {
        cmd.arg("--attach").arg(p);
    }
    spawn_detached(cmd).map_err(|e| AppError::Unsupported(format!("sem cliente de e-mail: {e}")))
}

/// Inicia sem esperar (o cliente de e-mail pode ficar aberto); uma thread recolhe o processo.
fn spawn_detached(mut cmd: Command) -> std::io::Result<()> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Roda `cmd` e devolve a saída padrão; mata o processo se passar de `timeout`.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> AppResult<String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Io("tempo esgotado".into()));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let mut out = String::new();
    if let Some(mut s) = child.stdout.take() {
        use std::io::Read;
        s.read_to_string(&mut out)?;
    }
    if !status.success() {
        return Err(AppError::Io(format!("saiu com {status}")));
    }
    Ok(out)
}

/// Procura um executável no `PATH` sem rodar nada.
fn in_path(name: &str, path: Option<&OsStr>) -> bool {
    path.is_some_and(|p| std::env::split_paths(p).any(|d| d.join(name).is_file()))
}

/// Saída de `kdeconnect-cli --list-available --id-name-only`: "<id> <nome>" por linha.
fn parse_devices(out: &str) -> Vec<Device> {
    out.lines()
        .filter_map(|l| {
            let (id, name) = l.trim().split_once(' ')?;
            Some(Device { id: id.into(), name: name.trim().into() })
        })
        .collect()
}

/// KDE Connect instalado (o item "KDE Connect…" só aparece nesse caso).
#[tauri::command]
pub async fn share_device_available() -> bool {
    in_path(KDECONNECT, std::env::var_os("PATH").as_deref())
}

/// Aparelhos alcançáveis agora.
#[tauri::command]
pub async fn share_devices() -> AppResult<Vec<Device>> {
    blocking(|| {
        let mut cmd = Command::new(KDECONNECT);
        cmd.args(["--list-available", "--id-name-only"]);
        run_with_timeout(cmd, KDECONNECT_TIMEOUT).map(|o| parse_devices(&o))
    })
    .await
}

/// Envia os arquivos para o aparelho `device` (um dos de `share_devices`).
#[tauri::command]
pub async fn share_device(store: State<'_, DocStore>, ids: Vec<DocId>, device: String) -> AppResult<()> {
    let paths = doc_paths(&store, &ids)?;
    blocking(move || {
        let mut list = Command::new(KDECONNECT);
        list.args(["--list-available", "--id-name-only"]);
        let known = parse_devices(&run_with_timeout(list, KDECONNECT_TIMEOUT)?);
        if !known.iter().any(|d| d.id == device) {
            return Err(AppError::NotFound("aparelho indisponível".into()));
        }
        for p in &paths {
            let mut cmd = Command::new(KDECONNECT);
            cmd.arg("-d").arg(&device).arg("--share").arg(p);
            run_with_timeout(cmd, KDECONNECT_TIMEOUT)?;
        }
        Ok(())
    })
    .await
}

/// O próprio app não aparece em "Abrir com".
fn is_self(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id.contains("geraviewimage") || id.contains("gera-view-image") || id == "gera view image.desktop"
}

/// Padrão do sistema primeiro, depois por nome; sem o próprio app nem repetidos.
fn order_apps(mut apps: Vec<AppEntry>, default: Option<&str>) -> Vec<AppEntry> {
    apps.retain(|a| !is_self(&a.id));
    apps.sort_by_key(|a| (Some(a.id.as_str()) != default, a.name.to_lowercase()));
    apps.dedup_by(|a, b| a.id == b.id);
    apps
}

/// Tipo pelo nome e pelos primeiros bytes. Com `data` vazio o GIO responde
/// `application/x-zerosize` (arquivo vazio), por isso o cabeçalho é lido.
fn content_type(path: &Path) -> String {
    use std::io::Read;
    let mut head = Vec::with_capacity(4096);
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(4096).read_to_end(&mut head);
    }
    gio::content_type_guess(Some(path), &head).0.to_string()
}

fn apps_for(path: &Path) -> Vec<AppEntry> {
    let ctype = content_type(path);
    let default = gio::AppInfo::default_for_type(&ctype, false).and_then(|a| a.id()).map(|s| s.to_string());
    let apps = gio::AppInfo::all_for_type(&ctype)
        .into_iter()
        .filter(|a| a.should_show())
        .filter_map(|a| {
            Some(AppEntry {
                id: a.id()?.to_string(),
                name: a.display_name().to_string(),
                icon: a.icon().and_then(|i| IconExt::to_string(&i)).map(|s| s.to_string()),
            })
        })
        .collect();
    order_apps(apps, default.as_deref())
}

fn doc_file(store: &DocStore, id: DocId) -> AppResult<PathBuf> {
    Ok(doc_paths(store, &[id])?.remove(0))
}

/// Apps que abrem o tipo do arquivo (Abrir com ▸).
#[tauri::command]
pub async fn open_with_apps(store: State<'_, DocStore>, id: DocId) -> AppResult<Vec<AppEntry>> {
    let path = doc_file(&store, id)?;
    blocking(move || Ok(apps_for(&path))).await
}

/// Abre o documento no app `app`. Só aceita um id da lista de `open_with_apps` (a interface não
/// escolhe executáveis arbitrários).
#[tauri::command]
pub async fn open_with_app(store: State<'_, DocStore>, id: DocId, app: String) -> AppResult<()> {
    let path = doc_file(&store, id)?;
    blocking(move || {
        if !apps_for(&path).iter().any(|a| a.id == app) {
            return Err(AppError::NotFound(format!("app não abre este arquivo: {app}")));
        }
        let info = gio::DesktopAppInfo::new(&app).ok_or_else(|| AppError::NotFound(app.clone()))?;
        info.launch(&[gio::File::for_path(&path)], None::<&gio::AppLaunchContext>)
            .map_err(|e| AppError::Io(e.to_string()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str) -> AppEntry {
        AppEntry { id: id.into(), name: name.into(), icon: None }
    }

    #[test]
    fn apps_padrao_primeiro_sem_o_proprio_app() {
        let list = vec![
            app("org.gimp.GIMP.desktop", "GIMP"),
            app("io.github.junior9283.geraviewimage.desktop", "Gera View Image"),
            app("org.kde.gwenview.desktop", "Gwenview"),
            app("eog.desktop", "Visualizador de imagens"),
            app("gera-view-image.desktop", "Gera View Image"),
        ];
        let ids: Vec<_> = order_apps(list, Some("org.kde.gwenview.desktop")).into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["org.kde.gwenview.desktop", "org.gimp.GIMP.desktop", "eog.desktop"]);
    }

    #[test]
    fn lista_de_aparelhos_do_kdeconnect() {
        let out = "a1b2c3 Pixel 7\n\nd4e5 Tablet da sala  \n";
        assert_eq!(
            parse_devices(out),
            [
                Device { id: "a1b2c3".into(), name: "Pixel 7".into() },
                Device { id: "d4e5".into(), name: "Tablet da sala".into() },
            ]
        );
        assert!(parse_devices("").is_empty());
    }

    #[test]
    fn subprocesso_travado_estoura_o_prazo() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let t = Instant::now();
        assert!(run_with_timeout(cmd, Duration::from_millis(200)).is_err());
        assert!(t.elapsed() < Duration::from_secs(2));
        let mut echo = Command::new("echo");
        echo.arg("oi");
        assert_eq!(run_with_timeout(echo, Duration::from_secs(5)).unwrap(), "oi\n");
    }

    #[test]
    fn procura_no_path_sem_executar() {
        let dir = std::env::temp_dir().join(format!("gvi-share-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(KDECONNECT), "").unwrap();
        let path = std::env::join_paths([Path::new("/nao/existe"), &dir]).unwrap();
        assert!(in_path(KDECONNECT, Some(&path)));
        assert!(!in_path("outro", Some(&path)));
        assert!(!in_path(KDECONNECT, None));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn assunto_com_os_nomes() {
        assert_eq!(subject(&[PathBuf::from("/a/x.jpg"), PathBuf::from("/b/y.png")]), "x.jpg, y.png");
    }

    #[test]
    fn tipo_pelo_nome_e_cabecalho() {
        let dir = std::env::temp_dir().join(format!("gvi-share-tipo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("foto.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        assert_eq!(content_type(&png), "image/png");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
