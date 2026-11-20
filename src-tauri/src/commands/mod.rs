//! Comandos Tauri. Cada tarefa acrescenta seus módulos aqui e registra em `lib.rs`.
pub mod docs;
pub mod edit;
pub mod view;

use crate::error::{AppError, AppResult};
use std::{sync::OnceLock, time::Instant};

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
