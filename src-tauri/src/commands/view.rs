//! Prévias em resolução de tela e miniaturas (bytes crus, sem JSON).
use super::{blocking, log_timing};
use crate::{
    doc::{
        model::{DocId, Rect},
        store::DocStore,
    },
    error::AppResult,
};
use tauri::{State, ipc::Response};

#[tauri::command]
pub async fn render_view(
    store: State<'_, DocStore>,
    id: DocId,
    frame: u32,
    max_w: u32,
    max_h: u32,
    region: Option<Rect>,
) -> AppResult<Response> {
    let store = store.inner().clone();
    let buf = blocking(move || store.render_view(id, frame, max_w, max_h, region)).await?;
    log_timing("render_view pronto");
    Ok(Response::new(buf))
}

#[tauri::command]
pub async fn thumbnail(
    store: State<'_, DocStore>,
    id: DocId,
    frame: u32,
    size: u32,
) -> AppResult<Response> {
    let store = store.inner().clone();
    blocking(move || store.thumbnail(id, frame, size))
        .await
        .map(Response::new)
}
