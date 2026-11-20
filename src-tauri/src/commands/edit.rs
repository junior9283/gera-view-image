//! Operações não destrutivas, desfazer e refazer.
use super::blocking;
use crate::{
    doc::{
        model::{DocId, DocInfo, Mask, Op},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::select,
};
use tauri::{AppHandle, State, image::Image};
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
        select::extract_region(&img, mask.as_ref())
            .ok_or_else(|| AppError::Unsupported("seleção vazia".into()))
    })
    .await?;
    let (w, h) = region.dimensions();
    app.clipboard()
        .write_image(&Image::new_owned(region.into_raw(), w, h))
        .map_err(|e| AppError::Io(e.to_string()))
}
