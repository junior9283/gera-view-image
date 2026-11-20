//! Operações não destrutivas, desfazer e refazer.
use super::blocking;
use crate::{
    doc::{
        model::{DocId, DocInfo, Op},
        store::DocStore,
    },
    error::AppResult,
};
use tauri::State;

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
