//! Metadados para o inspetor de informações.
use super::blocking;
use crate::{
    doc::{model::DocId, store::DocStore},
    error::AppResult,
    image::metadata::{Metadata, read_metadata},
};
use tauri::State;

#[tauri::command]
pub async fn metadata(store: State<'_, DocStore>, id: DocId) -> AppResult<Metadata> {
    let store = store.inner().clone();
    blocking(move || {
        let (path, source, full_size) =
            store.with_doc(id, |d| (d.info.path.clone(), d.source.clone(), d.full_size))?;
        let mut m = read_metadata(std::path::Path::new(&path), &source)?;
        // Durante a prévia reduzida os quadros são menores que o original.
        (m.general.width, m.general.height) = full_size;
        Ok(m)
    })
    .await
}
