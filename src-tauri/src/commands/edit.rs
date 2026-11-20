//! Operações não destrutivas, desfazer e refazer.
use super::blocking;
use crate::{
    doc::{
        model::{ColorAdjust, DocId, DocInfo, Mask, Op},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::{color, select},
};
use tauri::{AppHandle, State, image::Image, ipc::Response};
use tauri_plugin_clipboard_manager::ClipboardExt;

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

/// Alfa Instantâneo: máscara contígua à cor do pixel `(x, y)` (tolerância 0..=1).
#[tauri::command]
pub async fn instant_alpha(
    store: State<'_, DocStore>,
    id: DocId,
    x: u32,
    y: u32,
    tolerance: f32,
) -> AppResult<Mask> {
    let store = store.inner().clone();
    blocking(move || {
        let img = store.render_full(id, 0)?;
        Ok(select::instant_alpha(&img, (x, y), tolerance))
    })
    .await
}

/// Laço magnético: gruda o caminho nas bordas da imagem.
#[tauri::command]
pub async fn snap_lasso(
    store: State<'_, DocStore>,
    id: DocId,
    points: Vec<(f32, f32)>,
) -> AppResult<Vec<(f32, f32)>> {
    let store = store.inner().clone();
    blocking(move || {
        let img = store.render_full(id, 0)?;
        Ok(select::snap_lasso(&img, &points))
    })
    .await
}

/// Coloca a região selecionada (ou a imagem toda) na área de transferência como imagem.
#[tauri::command]
pub async fn copy_region(
    app: AppHandle,
    store: State<'_, DocStore>,
    id: DocId,
    mask: Option<Mask>,
) -> AppResult<()> {
    let store = store.inner().clone();
    let region = blocking(move || {
        let img = store.render_full(id, 0)?;
        select::extract_region(&img, mask.as_ref()).ok_or(AppError::EmptySelection)
    })
    .await?;
    let (w, h) = region.dimensions();
    app.clipboard()
        .write_image(&Image::new_owned(region.into_raw(), w, h))
        .map_err(|e| AppError::Io(e.to_string()))
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
