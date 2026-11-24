//! Leitura de canos de subprocessos sem risco de ficar presa.
use std::{
    io::Read,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

/// Quanto esperar o cano fechar depois que o processo terminou: um neto em outra sessão
/// (`setsid`) escapa do `kill` do grupo e pode segurá-lo para sempre; a thread de leitura nunca é
/// junta sem prazo.
pub const READ_GRACE: Duration = Duration::from_secs(2);

/// Leitura de um cano em thread própria, guardando até `max` bytes (o processo não trava com o
/// cano cheio).
pub struct Drain {
    kept: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

impl Drain {
    pub fn start(mut r: impl Read + Send + 'static, max: usize) -> Self {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let (tx, done) = mpsc::channel();
        let shared = kept.clone();
        std::thread::spawn(move || {
            let (mut buf, mut len) = ([0u8; 8192], 0);
            while let Ok(n) = r.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // No teto, o resto só é lido e descartado, sem tocar na trava.
                if len < max {
                    let room = (max - len).min(n);
                    shared.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&buf[..room]);
                    len += room;
                }
            }
            let _ = tx.send(());
        });
        Drain { kept, done }
    }

    /// O que foi lido até o cano fechar ou até `READ_GRACE` (a thread solta termina sozinha).
    pub fn finish(self) -> Vec<u8> {
        let _ = self.done.recv_timeout(READ_GRACE);
        std::mem::take(&mut *self.kept.lock().unwrap_or_else(|e| e.into_inner()))
    }
}
