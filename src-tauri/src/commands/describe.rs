//! Lote 9 (Inspetor completo): título, descrição, autor e texto alternativo editados no
//! Inspetor. As edições ficam em memória por documento e entram no arquivo no próximo
//! Salvar/Exportar (XMP e IPTC), junto de EXIF, ICC e do resto do XMP/IPTC originais.
use crate::{
    doc::{model::DocId, store::DocStore},
    error::AppResult,
};
use serde::Deserialize;
use tauri::State;

/// Campos editados no Inspetor (`None` = manter o do arquivo; `Some("")` = apagar); gravados no
/// próximo Salvar.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEdits {
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    /// Descrição da Imagem (texto alternativo).
    pub alt_text: Option<String>,
}

#[tauri::command]
pub fn edit_metadata(
    store: State<'_, DocStore>,
    id: DocId,
    edits: MetadataEdits,
) -> AppResult<()> {
    store.with_doc(id, |_| ())?; // documento inexistente = erro, não lixo no mapa
    store.set_meta_edits(id, &edits);
    Ok(())
}

/// Avisos da última gravação (`xmpRebuilt`, `exifDropped`, `textNotSaved`); o front os traduz e mostra.
#[tauri::command]
pub fn take_meta_notes(store: State<'_, DocStore>, id: DocId) -> Vec<&'static str> {
    store.take_meta_notes(id)
}
