//! Documentos novos sem arquivo: área de transferência e captura de tela (portal
//! `org.freedesktop.portal.Screenshot`, via zbus que já é dependência: nada novo no NEEDED).
//! Também o `OpenURI.OpenFile` com `ask=true` do "Abrir com…".
use super::blocking;
use crate::{
    doc::{
        model::{DocInfo, SourceFormat},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::decode::{self, Decoded},
};
use ::image::RgbaImage;
use serde::Deserialize;
use std::{collections::HashMap, os::fd::AsFd, path::Path};
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";

/// Novo da Área de Transferência / Colar: a imagem vira um documento sem arquivo.
#[tauri::command]
pub async fn new_from_clipboard(
    app: AppHandle,
    store: State<'_, DocStore>,
    name: String,
) -> AppResult<DocInfo> {
    let img = app
        .clipboard()
        .read_image()
        .map_err(|_| AppError::ClipboardEmpty)?;
    let rgba = RgbaImage::from_raw(img.width(), img.height(), img.rgba().to_vec())
        .ok_or(AppError::ClipboardEmpty)?;
    Ok(store.insert_untitled(&name, Decoded::single(rgba, SourceFormat::Png)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    Selection,
    Window,
    Screen,
}

/// Captura pelo portal. `None` = o usuário cancelou.
#[tauri::command]
pub async fn capture_screen(
    store: State<'_, DocStore>,
    mode: CaptureMode,
    name: String,
) -> AppResult<Option<DocInfo>> {
    let store = store.inner().clone();
    blocking(move || {
        let Some(path) = portal_screenshot(mode != CaptureMode::Screen)? else {
            return Ok(None);
        };
        let decoded = decode::decode(Path::new(&path))?;
        Ok(Some(store.insert_untitled(&name, decoded)))
    })
    .await
}

fn dbus_err(e: impl std::fmt::Display) -> AppError {
    AppError::Unsupported(format!("portal indisponível: {e}"))
}

/// Token único por pedido (o portal monta o caminho do Request com ele).
fn token() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!("gvi{}_{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
}

/// `Screenshot` do portal: caminho local do arquivo gerado, ou `None` se cancelado.
pub fn portal_screenshot(interactive: bool) -> AppResult<Option<String>> {
    let conn = zbus::blocking::Connection::session().map_err(dbus_err)?;
    let tok = token();
    let sender = conn
        .unique_name()
        .ok_or_else(|| dbus_err("sem nome único"))?
        .trim_start_matches(':')
        .replace('.', "_");
    let req = zbus::blocking::Proxy::new(
        &conn,
        PORTAL_DEST,
        format!("{PORTAL_PATH}/request/{sender}/{tok}"),
        "org.freedesktop.portal.Request",
    )
    .map_err(dbus_err)?;
    let mut responses = req.receive_signal("Response").map_err(dbus_err)?;
    let proxy = zbus::blocking::Proxy::new(
        &conn,
        PORTAL_DEST,
        PORTAL_PATH,
        "org.freedesktop.portal.Screenshot",
    )
    .map_err(dbus_err)?;
    let mut opts: HashMap<&str, Value> = HashMap::new();
    opts.insert("handle_token", Value::from(tok.as_str()));
    opts.insert("interactive", Value::from(interactive));
    opts.insert("modal", Value::from(true));
    let _: OwnedObjectPath = proxy
        .call("Screenshot", &("", opts))
        .map_err(dbus_err)?;
    let msg = responses
        .next()
        .ok_or_else(|| dbus_err("portal fechou sem responder"))?;
    let (code, results): (u32, HashMap<String, OwnedValue>) =
        msg.body().deserialize().map_err(dbus_err)?;
    if code != 0 {
        return Ok(None);
    }
    let uri: String = results
        .get("uri")
        .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
        .ok_or_else(|| dbus_err("resposta sem uri"))?;
    file_uri_to_path(&uri)
        .map(Some)
        .ok_or_else(|| dbus_err(format!("uri não local: {uri}")))
}

/// `file:///a%20b` → `/a b`.
pub fn file_uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `OpenURI.OpenFile` com `ask=true`: o sistema pergunta com qual aplicativo abrir.
pub fn portal_open_file(path: &Path) -> AppResult<()> {
    let file = std::fs::File::open(path)?;
    let conn = zbus::blocking::Connection::session().map_err(dbus_err)?;
    let proxy = zbus::blocking::Proxy::new(
        &conn,
        PORTAL_DEST,
        PORTAL_PATH,
        "org.freedesktop.portal.OpenURI",
    )
    .map_err(dbus_err)?;
    let mut opts: HashMap<&str, Value> = HashMap::new();
    opts.insert("ask", Value::from(true));
    opts.insert("handle_token", Value::from(token()));
    let _: OwnedObjectPath = proxy
        .call(
            "OpenFile",
            &("", zbus::zvariant::Fd::from(file.as_fd()), opts),
        )
        .map_err(dbus_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::file_uri_to_path;

    #[test]
    fn uri_com_acento_e_espaco() {
        assert_eq!(
            file_uri_to_path("file:///home/u/Imagens/Captura%20de%20tela%20A%C3%A7%C3%A3o.png")
                .as_deref(),
            Some("/home/u/Imagens/Captura de tela Ação.png")
        );
        assert_eq!(file_uri_to_path("https://x"), None);
        assert_eq!(file_uri_to_path("file:///a%2"), None);
    }
}
