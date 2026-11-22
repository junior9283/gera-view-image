//! Lote 4 (Remover Fundo / Copiar Objeto): máscara do sujeito principal.
//!
//! O modelo (`image::segment`) é baixado no primeiro uso para `<app_data_dir>/models/`, só
//! depois que a interface pede o consentimento (`segment_model_ready` = falso), e conferido
//! pelo SHA-256 a cada carga. Download, decodificação e inferência rodam fora da thread
//! principal; `segment_cancel` interrompe o download e descarta o resultado da inferência.
use super::{Epochs, blocking};
use crate::{
    doc::{
        model::{DocId, Mask},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::segment::{self, Job, MODEL_FILE, MODEL_MAX_BYTES, MODEL_SHA256, MODEL_URL, Model},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// Modelo já carregado (vale pela vida do processo).
static MODEL: Mutex<Option<Arc<Model>>> = Mutex::new(None);

fn cached() -> Option<Arc<Model>> {
    MODEL.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn model_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(dir.join("models").join(MODEL_FILE))
}

/// O modelo já está no disco (com o hash certo)? Falso = Remover Fundo vai baixá-lo.
#[tauri::command]
pub async fn segment_model_ready(app: AppHandle) -> AppResult<bool> {
    if cached().is_some() {
        return Ok(true);
    }
    let path = model_path(&app)?;
    blocking(move || Ok(segment::read_model(&path, MODEL_SHA256).is_some())).await
}

/// Máscara do sujeito; Remover Fundo aplica `Op::MakeTransparent` sobre o inverso dela.
/// Sem sujeito destacado: `empty_selection`.
#[tauri::command]
pub async fn segment_subject(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, DocStore>,
    id: DocId,
) -> AppResult<Mask> {
    let job = Job::on(EPOCHS.of(window.label()));
    let model = match cached() {
        Some(m) => m,
        None => load_model(model_path(&app)?, job).await?,
    };
    job.check()?;
    let store = store.inner().clone();
    blocking(move || {
        let img = store.render_full(id, 0)?;
        job.check()?;
        let mask = segment::subject_mask(&model, &img)?;
        job.check()?;
        Ok(mask)
    })
    .await
}

/// Segmentações da janela: `segment_cancel` invalida as que já começaram nela.
static EPOCHS: Epochs = Epochs::new();

/// Cancela as segmentações em andamento na janela (download incluído).
#[tauri::command]
pub fn segment_cancel(window: WebviewWindow) {
    cancel(window.label());
}

/// Cancela as segmentações da janela (também quando ela fecha).
pub fn cancel(label: &str) {
    EPOCHS.of(label).fetch_add(1, Ordering::SeqCst);
}

/// Lê o modelo do disco ou o baixa (conferindo o hash), e o guarda carregado.
async fn load_model(path: PathBuf, job: Job) -> AppResult<Arc<Model>> {
    let p = path.clone();
    let bytes = match blocking(move || Ok(segment::read_model(&p, MODEL_SHA256))).await? {
        Some(b) => b,
        None => {
            let b = download(&client(true)?, MODEL_URL, MODEL_MAX_BYTES, job).await?;
            job.check()?;
            blocking(move || segment::install_model(&path, &b, MODEL_SHA256).map(|_| b)).await?
        }
    };
    let model = Arc::new(blocking(move || Model::load(&bytes)).await?);
    *MODEL.lock().unwrap_or_else(|e| e.into_inner()) = Some(model.clone());
    Ok(model)
}

fn net(e: reqwest::Error) -> AppError {
    AppError::Io(format!("download do modelo: {e}"))
}

/// Cliente do download do modelo; em produção, só HTTPS (inclusive nos redirecionamentos).
fn client(https_only: bool) -> AppResult<reqwest::Client> {
    // O reqwest vem sem provedor de criptografia (o mesmo do updater: ring).
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .https_only(https_only)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(net)
}

/// Baixa `url` inteiro (no máximo `max` bytes), parando se o trabalho for cancelado.
async fn download(client: &reqwest::Client, url: &str, max: usize, job: Job) -> AppResult<Vec<u8>> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(net)?;
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        job.check()?;
        if buf.len() + chunk.len() > max {
            return Err(AppError::Corrupt("modelo maior que o esperado".into()));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::AtomicU64,
    };

    fn job() -> Job {
        Job::on(Box::leak(Box::default()))
    }

    /// Servidor HTTP de uma resposta só, em 127.0.0.1 (o CI não acessa a rede).
    fn serve_once(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let _ = s.read(&mut req);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&body);
        });
        format!("http://{addr}/u2netp.onnx")
    }

    #[test]
    fn baixa_o_modelo_inteiro() {
        let body: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        let url = serve_once(body.clone());
        let got = tauri::async_runtime::block_on(download(&client(false).unwrap(), &url, 1 << 20, job())).unwrap();
        assert_eq!(got, body);
    }

    #[test]
    fn cliente_de_producao_recusa_http() {
        let url = serve_once(vec![1; 16]);
        let client = client(true).unwrap();
        let e = tauri::async_runtime::block_on(download(&client, &url, 1000, job())).unwrap_err();
        assert_eq!(e.code(), "io");
    }

    #[test]
    fn recusa_download_maior_que_o_teto() {
        let url = serve_once(vec![7; 4096]);
        let e = tauri::async_runtime::block_on(download(&client(false).unwrap(), &url, 1000, job())).unwrap_err();
        assert_eq!(e.code(), "corrupt");
    }

    #[test]
    fn download_cancelado_para() {
        let url = serve_once(vec![1; 4096]);
        static E: AtomicU64 = AtomicU64::new(0);
        let job = Job::on(&E);
        E.fetch_add(1, Ordering::SeqCst);
        let e = tauri::async_runtime::block_on(download(&client(false).unwrap(), &url, 1 << 20, job)).unwrap_err();
        assert_eq!(e.code(), "io");
    }
}
