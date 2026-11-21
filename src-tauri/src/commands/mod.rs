//! Comandos Tauri. Cada tarefa acrescenta seus módulos aqui e registra em `lib.rs`.
pub mod capture;
pub mod docs;
pub mod drag;
pub mod edit;
pub mod file;
pub mod meta;
pub mod theme;
pub mod view;
// Lotes de paridade (Lote 0 criou os stubs; cada lote preenche só o seu módulo).
pub mod color; // Lote 1
pub mod describe; // Lote 9
pub mod finder; // Lote 5
pub mod fonts; // Lote 10
pub mod ocr; // Lote 3
pub mod paste; // Lote 2
pub mod print; // Lote 11
pub mod segment; // Lote 4
pub mod share; // Lote 6
pub mod sidebar; // Lote 7
pub mod window; // Lote 12

use crate::error::{AppError, AppResult};
use std::{sync::OnceLock, time::Instant};

/// Resposta dos comandos criados pelo Lote 0 enquanto o lote dono não os implementa.
pub(crate) fn not_yet<T>(command: &str) -> AppResult<T> {
    Err(AppError::Unsupported(format!("{command}: ainda não implementado")))
}

/// Roda trabalho pesado fora da thread principal (comandos síncronos do Tauri rodam nela).
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

static T0: OnceLock<Instant> = OnceLock::new();

/// Marca o início do processo para `log_timing`.
pub fn mark_start() {
    T0.get_or_init(Instant::now);
}

/// Com `GVI_TIMING=1`, registra no stderr o tempo desde o início do processo.
pub fn log_timing(event: &str) {
    if std::env::var_os("GVI_TIMING").is_some() {
        let ms = T0.get().map_or(0, |t| t.elapsed().as_millis());
        eprintln!("[gvi {ms:>6} ms] {event}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::model::DocId;

    #[test]
    fn stubs_dos_lotes_devolvem_unsupported() {
        let e = fonts::system_fonts().unwrap_err();
        assert_eq!(e.code(), "unsupported");
        assert!(e.to_string().contains("system_fonts"));
        assert_eq!(segment::segment_subject(DocId(1)).unwrap_err().code(), "unsupported");
        assert_eq!(window::list_windows().unwrap_err().code(), "unsupported");
    }
}
