//! Copiar e colar miniaturas como arquivos (Ctrl+C/Ctrl+V na barra lateral e na folha de contatos).
//! Usa a área de transferência do GTK, que já está ligado: `text/uri-list` e
//! `x-special/gnome-copied-files` (gerenciadores de arquivos) e, com uma imagem só, também o PNG
//! (editores). O plugin de área de transferência do Tauri não oferece lista de arquivos.
use super::{
    blocking,
    drag::{DragSource, DragTemp, file_uris, resolve},
    paste::{copied_region, png_bytes},
};
use crate::{
    doc::store::DocStore,
    error::{AppError, AppResult},
};
use std::path::PathBuf;
use tauri::{State, WebviewWindow};

/// Máximo de arquivos lidos da área de transferência.
const MAX_FILES: usize = 1000;

/// O que Copiar põe na área de transferência.
pub struct Payload {
    pub uris: Vec<String>,
    pub paths: Vec<PathBuf>,
    /// Com uma imagem só, o PNG dela.
    pub png: Option<Vec<u8>>,
}

/// Conteúdo de `x-special/gnome-copied-files`.
pub fn gnome_copied_files(uris: &[String]) -> String {
    std::iter::once("copy").chain(uris.iter().map(String::as_str)).collect::<Vec<_>>().join("\n")
}

/// Caminhos locais de uma lista de URIs (sem as de outros esquemas ou máquinas, nem o que não é arquivo).
pub fn local_files<'a>(uris: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    uris.into_iter()
        .filter_map(|u| match gtk::glib::filename_from_uri(u) {
            Ok((path, None)) if path.is_file() => path.to_str().map(String::from),
            _ => None,
        })
        .take(MAX_FILES)
        .collect()
}

/// Copia os documentos como arquivos (os alterados ou sem arquivo, como PNG temporário).
#[tauri::command]
pub async fn copy_files(
    window: WebviewWindow,
    store: State<'_, DocStore>,
    temp: State<'_, DragTemp>,
    items: Vec<DragSource>,
    frame: Option<u32>,
) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let store = store.inner().clone();
    let base = temp.0.clone();
    let payload = blocking(move || {
        let paths = resolve(&store, &base, &items)?;
        let png = match items.as_slice() {
            [one] => Some(png_bytes(&copied_region(&store, one.id, frame.unwrap_or(0), None, None)?)?),
            _ => None,
        };
        Ok(Payload { uris: file_uris(&paths)?, paths, png })
    })
    .await?;
    on_main(&window, move |tx| {
        let _ = tx.try_send(native::set(&native::clipboard(), payload));
    })
    .await?
}

/// Arquivos na área de transferência (copiados no gerenciador de arquivos ou aqui).
#[tauri::command]
pub async fn clipboard_files(window: WebviewWindow) -> AppResult<Vec<String>> {
    on_main(&window, |tx| {
        native::request(&native::clipboard(), move |files| {
            let _ = tx.try_send(files);
        })
    })
    .await
}

type Sender<T> = tauri::async_runtime::Sender<T>;

/// Roda `f` na thread do GTK e espera o que ela enviar.
async fn on_main<T: Send + 'static>(
    window: &WebviewWindow,
    f: impl FnOnce(Sender<T>) + Send + 'static,
) -> AppResult<T> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || f(tx))
        .map_err(|e| AppError::Io(e.to_string()))?;
    rx.recv()
        .await
        .ok_or_else(|| AppError::Io("área de transferência indisponível".into()))
}

/// A parte do GTK (só na thread principal).
pub mod native {
    use super::{Payload, gnome_copied_files, local_files};
    use crate::error::{AppError, AppResult};
    use gtk::{Clipboard, TargetEntry, TargetFlags, gdk};

    const URIS: u32 = 0;
    const GNOME: u32 = 1;
    const TEXT: u32 = 2;
    const PNG: u32 = 3;

    pub fn clipboard() -> Clipboard {
        Clipboard::get(&gdk::SELECTION_CLIPBOARD)
    }

    pub fn set(clipboard: &Clipboard, payload: Payload) -> AppResult<()> {
        let mut targets = vec![
            ("text/uri-list", URIS),
            ("x-special/gnome-copied-files", GNOME),
            ("text/plain;charset=utf-8", TEXT),
            ("UTF8_STRING", TEXT),
        ];
        if payload.png.is_some() {
            targets.push(("image/png", PNG));
        }
        let targets: Vec<_> = targets
            .into_iter()
            .map(|(name, info)| TargetEntry::new(name, TargetFlags::empty(), info))
            .collect();
        let gnome = gnome_copied_files(&payload.uris);
        let text = payload
            .paths
            .iter()
            .map(|p| p.to_string_lossy())
            .collect::<Vec<_>>()
            .join("\n");
        let ok = clipboard.set_with_data(&targets, move |_, sel, info| match info {
            URIS => {
                let uris: Vec<&str> = payload.uris.iter().map(String::as_str).collect();
                sel.set_uris(&uris);
            }
            GNOME => sel.set(&sel.target(), 8, gnome.as_bytes()),
            TEXT => {
                sel.set_text(&text);
            }
            _ => sel.set(&sel.target(), 8, payload.png.as_deref().unwrap_or_default()),
        });
        ok.then_some(())
            .ok_or_else(|| AppError::Io("o GTK recusou a área de transferência".into()))
    }

    /// Pede a lista de arquivos e chama `done` quando o dono da área responder.
    pub fn request(clipboard: &Clipboard, done: impl FnOnce(Vec<String>) + 'static) {
        clipboard.request_uris(move |_, uris| done(local_files(uris.iter().map(|u| u.as_str()))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formato_do_gnome_comeca_com_a_acao() {
        let uris = ["file:///fotos/S%C3%A3o%20Jo%C3%A3o.png".to_string(), "file:///b.jpg".to_string()];
        assert_eq!(
            gnome_copied_files(&uris),
            "copy\nfile:///fotos/S%C3%A3o%20Jo%C3%A3o.png\nfile:///b.jpg"
        );
    }

    #[test]
    fn so_arquivos_locais_existentes_na_ordem() {
        let dir = std::env::temp_dir().join(format!("gvi-clip-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("pasta")).unwrap();
        let (a, b) = (dir.join("São João.png"), dir.join("b.jpg"));
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "x").unwrap();
        let mut uris = file_uris(&[b.clone(), a.clone(), dir.join("pasta"), dir.join("sumiu.png")]).unwrap();
        uris.extend(["https://exemplo.com/x.png", "file://outra/a.png", "lixo", ""].map(String::from));
        let got = local_files(uris.iter().map(String::as_str));
        // Teto: uma lista absurda não vira milhares de documentos.
        let many = vec![uris[0].as_str(); MAX_FILES + 50];
        let capped = local_files(many).len();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(got, [b.to_str().unwrap(), a.to_str().unwrap()]);
        assert_eq!(capped, MAX_FILES);
    }
}
