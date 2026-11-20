//! Operações não destrutivas, desfazer e refazer.
use super::blocking;
use crate::{
    doc::{
        model::{ColorAdjust, DocId, DocInfo, Op},
        store::DocStore,
    },
    error::AppResult,
    image::color,
};
use tauri::{State, ipc::Response};

#[tauri::command]
pub async fn apply_op(store: State<'_, DocStore>, id: DocId, op: Op) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.apply_op(id, op)).await
}

#[tauri::command]
pub async fn undo(store: State<'_, DocStore>, id: DocId) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.undo(id)).await
}

#[tauri::command]
pub async fn redo(store: State<'_, DocStore>, id: DocId) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.redo(id)).await
}

/// Prévia de um ajuste de cor em resolução de tela; não altera o documento.
#[tauri::command]
pub async fn preview_adjust(
    store: State<'_, DocStore>,
    id: DocId,
    adjust: ColorAdjust,
    max_w: u32,
    max_h: u32,
) -> AppResult<Response> {
    let store = store.inner().clone();
    blocking(move || {
        let mut buf = store.render_view(id, 0, max_w, max_h, None)?;
        color::adjust_view_buffer(&mut buf, &adjust);
        Ok(buf)
    })
    .await
    .map(Response::new)
}

/// Lado máximo da amostra usada para histograma e níveis automáticos.
const SAMPLE: u32 = 1024;

fn sample(store: &DocStore, id: DocId) -> AppResult<::image::RgbaImage> {
    color::view_buffer_image(&store.render_view(id, 0, SAMPLE, SAMPLE, None)?)
}

#[tauri::command]
pub async fn histogram(store: State<'_, DocStore>, id: DocId) -> AppResult<color::Histogram> {
    let store = store.inner().clone();
    blocking(move || Ok(color::histogram(&sample(&store, id)?))).await
}

#[tauri::command]
pub async fn auto_levels(store: State<'_, DocStore>, id: DocId) -> AppResult<ColorAdjust> {
    let store = store.inner().clone();
    blocking(move || Ok(color::auto_levels(&sample(&store, id)?))).await
}
