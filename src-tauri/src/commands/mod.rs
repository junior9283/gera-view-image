//! Comandos Tauri. Cada tarefa acrescenta seus módulos aqui e registra em `lib.rs`.
pub mod capture;
pub mod clipfiles;
pub mod docs;
pub mod drag;
pub mod edit;
pub mod file;
pub mod instance;
pub mod meta;
pub mod theme;
pub mod view;
// Lotes de paridade (Lote 0 criou os stubs; cada lote preenche só o seu módulo).
pub mod camera; // Lote 10
pub mod color; // Lote 1
pub mod describe; // Lote 9
pub mod finder; // Lote 5
pub mod fonts; // Lote 10
pub mod ocr; // Lote 3
pub mod paste; // Lote 2
pub mod print; // Lote 11
pub mod scan; // Lote 12 (Importar do Scanner)
pub mod segment; // Lote 4
pub mod share; // Lote 6
pub mod sidebar; // Lote 7
pub mod window; // Lote 12

use crate::error::{AppError, AppResult};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock, atomic::AtomicU64},
    time::Instant,
};

/// Roda trabalho pesado fora da thread principal (comandos síncronos do Tauri rodam nela).
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

/// Contadores de cancelamento por janela (rótulo): cancelar numa não derruba o trabalho da outra.
pub(crate) struct Epochs(Mutex<BTreeMap<String, &'static AtomicU64>>);

impl Epochs {
    pub(crate) const fn new() -> Self {
        Epochs(Mutex::new(BTreeMap::new()))
    }

    /// Vale pela vida do processo (8 bytes por janela já aberta).
    pub(crate) fn of(&self, label: &str) -> &'static AtomicU64 {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(label.to_string()).or_insert_with(|| Box::leak(Box::default()))
    }
}

/// Roda uma função uma vez, quando cai. Guardado na tabela de recursos do app, que o Tauri esvazia
/// em `cleanup_before_exit` em toda saída, inclusive nos caminhos do reinício (atualizador) que
/// pulam o `RunEvent::Exit`.
pub struct OnDrop(Mutex<Option<Box<dyn FnOnce() + Send>>>);

impl OnDrop {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        OnDrop(Mutex::new(Some(Box::new(f))))
    }
}

impl tauri::Resource for OnDrop {}

impl Drop for OnDrop {
    fn drop(&mut self) {
        if let Some(f) = self.0.get_mut().unwrap_or_else(|e| e.into_inner()).take() {
            f();
        }
    }
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

    #[test]
    fn cancelar_numa_janela_nao_mexe_na_outra() {
        use std::sync::atomic::Ordering::SeqCst;
        static E: Epochs = Epochs::new();
        E.of("main").fetch_add(1, SeqCst);
        assert_eq!(E.of("main").load(SeqCst), 1);
        assert_eq!(E.of("doc-1").load(SeqCst), 0);
    }

    #[test]
    fn limpeza_roda_quando_a_tabela_de_recursos_e_esvaziada() {
        use std::sync::{Arc, atomic::{AtomicU32, Ordering::SeqCst}};
        let runs = Arc::new(AtomicU32::new(0));
        let mut table = tauri::ResourceTable::default();
        let r = runs.clone();
        table.add(OnDrop::new(move || {
            r.fetch_add(1, SeqCst);
        }));
        assert_eq!(runs.load(SeqCst), 0);
        drop(table);
        assert_eq!(runs.load(SeqCst), 1);
    }
}
