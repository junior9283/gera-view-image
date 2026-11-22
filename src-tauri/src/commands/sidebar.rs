//! Lote 7 (Barra lateral avançada): dados do arquivo para Ordenar Por (Data e Tamanho).
use super::blocking;
use crate::{
    doc::{model::DocId, store::DocStore},
    error::AppResult,
};
use serde::Serialize;
use std::{fs, time::UNIX_EPOCH};
use tauri::State;

/// Data de modificação (ms desde 1970) e tamanho em disco; `None` sem arquivo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub id: DocId,
    pub modified_ms: Option<u64>,
    pub size: Option<u64>,
}

/// Lê os metadados de `path`. Caminho vazio, apagado ou ilegível devolve `None` nos dois campos:
/// a barra só precisa saber que não há dado, nunca falha por causa de um arquivo.
fn stat_path(id: DocId, path: &str) -> FileStat {
    let meta = if path.is_empty() { None } else { fs::metadata(path).ok().filter(|m| m.is_file()) };
    let modified_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    FileStat { id, modified_ms, size: meta.map(|m| m.len()) }
}

/// Dados de disco dos documentos abertos (só ids que a aplicação conhece; o caminho vem do
/// documento, nunca do chamador). Id desconhecido ou sem arquivo volta com `None`.
#[tauri::command]
pub async fn file_stats(store: State<'_, DocStore>, ids: Vec<DocId>) -> AppResult<Vec<FileStat>> {
    let paths: Vec<(DocId, String)> =
        ids.into_iter().map(|id| (id, store.info(id).map(|i| i.path).unwrap_or_default())).collect();
    blocking(move || Ok(paths.iter().map(|(id, p)| stat_path(*id, p)).collect())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn dir(nome: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gvi-sidebar-{nome}-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn le_data_e_tamanho_do_arquivo() {
        let d = dir("stat");
        let f = d.join("a.png");
        fs::write(&f, [0u8; 123]).unwrap();
        let quando = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::File::options().write(true).open(&f).unwrap().set_modified(quando).unwrap();
        let s = stat_path(DocId(7), f.to_str().unwrap());
        assert_eq!(s.size, Some(123));
        assert_eq!(s.modified_ms, Some(1_700_000_000_000));
        assert_eq!(s.id, DocId(7));
    }

    #[test]
    fn sem_arquivo_nao_falha() {
        let d = dir("sem");
        let ausente = d.join("nao-existe.png");
        for p in ["", ausente.to_str().unwrap(), d.to_str().unwrap()] {
            let s = stat_path(DocId(1), p);
            assert_eq!((s.modified_ms, s.size), (None, None), "caminho {p:?}");
        }
    }

    #[test]
    fn serializa_em_camel_case() {
        let j = serde_json::to_value(FileStat { id: DocId(3), modified_ms: Some(5), size: None }).unwrap();
        assert_eq!(j, serde_json::json!({ "id": 3, "modifiedMs": 5, "size": null }));
    }
}
