//! Lote 3 (Texto ao Vivo): OCR, QR code, fala e consultas na web.
//!
//! - O OCR roda fora da thread principal (`blocking`), fica em cache por documento, quadro e
//!   revisão, e é cancelado quando outro pedido começa (troca de imagem) ou por
//!   `cancel_text_recognition`.
//! - Os modelos são baixados só quando o usuário pede (`download_ocr_models`), com SHA-256 fixo.
//! - Nada é enviado para fora: `open_web` só abre o navegador quando o usuário escolhe Traduzir,
//!   Pesquisar ou Pesquisar Imagem na Web (esta última não envia a imagem: ela vai para a área de
//!   transferência e o usuário decide colar na página).
use super::blocking;
use crate::{
    doc::{model::DocId, store::DocStore},
    error::{AppError, AppResult},
    image::ocr::{self as core, Engine, MODELS, ModelSpec},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

pub use core::{DetectedCode, TextLine, TextWord};

/// Evento de progresso do download dos modelos.
pub const MODELS_PROGRESS_EVENT: &str = "ocr-models-progress";
/// Resultados guardados (documento, quadro, revisão).
const CACHE_LEN: usize = 32;

type Key = (DocId, u32, u64);

#[derive(Default)]
struct OcrState {
    engine: Mutex<Option<Arc<Engine>>>,
    cache: Mutex<VecDeque<(Key, Arc<Vec<TextLine>>)>>,
    /// Muda a cada pedido novo ou cancelamento; o pedido em curso para quando ela muda.
    generation: AtomicU64,
    downloading: AtomicBool,
}

static STATE: LazyLock<OcrState> = LazyLock::new(OcrState::default);

fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    Ok(dir.join("models").join("pp-ocrv5"))
}

fn io(e: impl std::fmt::Display) -> AppError {
    AppError::Io(e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrModels {
    pub installed: bool,
    /// Bytes que faltam baixar.
    pub download_bytes: u64,
}

fn models_status(dir: &Path) -> OcrModels {
    let missing: Vec<&ModelSpec> = MODELS.iter().filter(|m| !core::model_ok(dir, m)).collect();
    OcrModels { installed: missing.is_empty(), download_bytes: missing.iter().map(|m| m.size).sum() }
}

/// Os modelos do Texto ao Vivo estão instalados?
#[tauri::command]
pub async fn ocr_models(app: AppHandle) -> AppResult<OcrModels> {
    if STATE.engine.lock().unwrap().is_some() {
        return Ok(OcrModels { installed: true, download_bytes: 0 });
    }
    let dir = models_dir(&app)?;
    blocking(move || Ok(models_status(&dir))).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: u64,
    total: u64,
}

/// Baixa os modelos que faltam (só por pedido do usuário). Grava em `.part`, confere tamanho e
/// SHA-256 e só então renomeia; com hash errado, apaga e devolve `corrupt`.
#[tauri::command]
pub async fn download_ocr_models(app: AppHandle) -> AppResult<()> {
    if STATE.downloading.swap(true, Ordering::SeqCst) {
        return Err(AppError::Unsupported("ocr: download em andamento".into()));
    }
    // Limpa o estado mesmo com erro ou pânico no meio do download.
    struct Busy;
    impl Drop for Busy {
        fn drop(&mut self) {
            STATE.downloading.store(false, Ordering::SeqCst);
        }
    }
    let _busy = Busy;
    download(&app).await
}

async fn download(app: &AppHandle) -> AppResult<()> {
    let dir = models_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(io)?;
    let missing: Vec<ModelSpec> = {
        let dir = dir.clone();
        blocking(move || Ok(MODELS.into_iter().filter(|m| !core::model_ok(&dir, m)).collect())).await?
    };
    let total: u64 = missing.iter().map(|m| m.size).sum();
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("gera-view-image/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(io)?;
    let mut done = 0;
    for spec in missing {
        let part = dir.join(format!("{}.part", spec.file));
        let fetched = fetch(app, &client, &spec, &part, &mut done, total).await;
        if fetched.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        fetched?;
        std::fs::rename(&part, dir.join(spec.file)).map_err(io)?;
    }
    Ok(())
}

/// Baixa um modelo em `part`, conferindo tamanho e SHA-256.
async fn fetch(
    app: &AppHandle,
    client: &reqwest::Client,
    spec: &ModelSpec,
    part: &Path,
    done: &mut u64,
    total: u64,
) -> AppResult<()> {
    let mut res = client.get(spec.url).send().await.map_err(io)?.error_for_status().map_err(io)?;
    let mut file = std::fs::File::create(part).map_err(io)?;
    let mut hash = Sha256::new();
    let mut len = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(io)? {
        len += chunk.len() as u64;
        if len > spec.size {
            break;
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(io)?;
        *done += chunk.len() as u64;
        let _ = app.emit(MODELS_PROGRESS_EVENT, Progress { done: *done, total });
    }
    if len != spec.size || core::hex(&hash.finalize()) != spec.sha256 {
        return Err(AppError::Corrupt(format!("ocr: {} com tamanho ou hash inesperado", spec.file)));
    }
    Ok(())
}

/// Motor carregado (uma vez); `not_found` se os modelos não estão instalados.
fn engine(dir: &Path) -> AppResult<Arc<Engine>> {
    let mut slot = STATE.engine.lock().unwrap();
    if let Some(e) = slot.as_ref() {
        return Ok(e.clone());
    }
    if !models_status(dir).installed {
        return Err(AppError::NotFound("ocr: modelos não instalados".into()));
    }
    let e = Arc::new(Engine::load(dir)?);
    *slot = Some(e.clone());
    Ok(e)
}

fn cached(key: Key) -> Option<Arc<Vec<TextLine>>> {
    STATE.cache.lock().unwrap().iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
}

fn remember(key: Key, lines: Arc<Vec<TextLine>>) {
    let mut c = STATE.cache.lock().unwrap();
    c.retain(|(k, _)| !(k.0 == key.0 && k.1 == key.1));
    c.push_back((key, lines));
    while c.len() > CACHE_LEN {
        c.pop_front();
    }
}

/// Texto do quadro, com caixas em px da imagem. Um pedido novo cancela o anterior.
#[tauri::command]
pub async fn recognize_text(
    app: AppHandle,
    store: State<'_, DocStore>,
    id: DocId,
    frame: u32,
) -> AppResult<Vec<TextLine>> {
    let generation = STATE.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let store = store.inner().clone();
    let dir = models_dir(&app)?;
    blocking(move || {
        let key = (id, frame, store.info(id)?.rev);
        if let Some(lines) = cached(key) {
            return Ok(lines.as_ref().clone());
        }
        let engine = engine(&dir)?;
        let cancelled = || STATE.generation.load(Ordering::SeqCst) != generation;
        let img = store.render_full(id, frame)?;
        if cancelled() {
            return Err(core::cancelled_error());
        }
        let lines = Arc::new(engine.recognize(&img, &cancelled)?);
        remember(key, lines.clone());
        Ok(lines.as_ref().clone())
    })
    .await
}

/// Para o reconhecimento em curso (a imagem ativa mudou ou o Texto ao Vivo foi desligado).
#[tauri::command]
pub fn cancel_text_recognition() {
    STATE.generation.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub async fn detect_codes(store: State<'_, DocStore>, id: DocId, frame: u32) -> AppResult<Vec<DetectedCode>> {
    let store = store.inner().clone();
    blocking(move || Ok(core::detect_codes(&*store.render_full(id, frame)?))).await
}

/// Texto máximo passado ao `spd-say` (limite de argumento do sistema).
const MAX_SPEECH_CHARS: usize = 20_000;

fn spd_say(args: &[&str]) -> AppResult<()> {
    let mut child = std::process::Command::new("spd-say").args(args).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Unsupported("spd-say".into())
        } else {
            io(e)
        }
    })?;
    // O `spd-say` só entrega o texto ao Speech Dispatcher e sai; o `wait` evita processo zumbi.
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Edição › Fala › Iniciar Fala (Speech Dispatcher, se instalado; senão `unsupported`).
#[tauri::command(async)]
pub fn speak(text: String) -> AppResult<()> {
    let text: String = text.chars().take(MAX_SPEECH_CHARS).collect();
    if text.trim().is_empty() {
        return Ok(());
    }
    spd_say(&["--", &text])
}

#[tauri::command(async)]
pub fn stop_speaking() -> AppResult<()> {
    spd_say(&["--cancel"])
}

/// Copia texto (Copiar Todo o Texto, texto selecionado na imagem).
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> AppResult<()> {
    app.clipboard().write_text(text).map_err(io)
}

/// Percent-encoding de componente de URL (RFC 3986: só os não reservados passam).
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// URL de cada consulta. `link` só aceita http(s), e-mail e telefone.
pub fn web_url(kind: &str, text: &str, lang: &str) -> AppResult<String> {
    let text = text.trim();
    let lang: String = lang.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(10).collect();
    Ok(match kind {
        "translate" => format!("https://translate.google.com/?sl=auto&tl={lang}&text={}&op=translate", encode(text)),
        "search" => format!("https://www.google.com/search?q={}", encode(text)),
        "images" => "https://images.google.com/".to_string(),
        "link" => safe_link(text)?,
        _ => return Err(AppError::Unsupported(format!("open_web: {kind}"))),
    })
}

/// Campos de `mailto:` que podem seguir (o resto, como `attach`, é descartado).
const MAILTO_FIELDS: [&str; 4] = ["subject", "body", "cc", "bcc"];

/// Endereço de e-mail único, só com caracteres seguros (sem `%`, `,`, `/`, `?`, espaço…).
fn plain_address(s: &str) -> bool {
    let ok = |c: char, extra: &str| c.is_alphanumeric() || extra.contains(c);
    match s.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && local.chars().all(|c| ok(c, "._+-"))
                && domain.chars().all(|c| ok(c, ".-"))
        }
        None => false,
    }
}

/// Link lido da imagem (não confiável), reconstruído a partir das partes interpretadas: nunca
/// repassa a string crua. `http(s)` com host válido, `mailto:` com um endereço e só os campos de
/// `MAILTO_FIELDS`, `tel:` com dígitos e `+-() `. Qualquer outro esquema é recusado.
fn safe_link(text: &str) -> AppResult<String> {
    let bad = || AppError::Unsupported(format!("link: {text}"));
    let lower = text.to_ascii_lowercase();
    if let Some(number) = lower.strip_prefix("tel:") {
        let ok = number.chars().any(|c| c.is_ascii_digit())
            && number.chars().all(|c| c.is_ascii_digit() || "+-() ".contains(c));
        return if ok { Ok(format!("tel:{}", number.replace(' ', ""))) } else { Err(bad()) };
    }
    if text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(bad());
    }
    let url = url::Url::parse(text).map_err(|_| bad())?;
    match url.scheme() {
        "http" | "https" => {
            // `https:///etc` e `http:exemplo` viram hosts válidos no WHATWG: exige `//host`.
            let host_first = lower.split_once("://").is_some_and(|(_, r)| !r.starts_with(['/', '\\']));
            // `https://google.com@evil.example` engana quem lê: userinfo é sempre recusado.
            let userinfo = !url.username().is_empty() || url.password().is_some() || rest_has_at(&lower);
            if !host_first || userinfo || url.host_str().is_none_or(str::is_empty) {
                return Err(bad());
            }
            Ok(url.to_string())
        }
        "mailto" => {
            let address = url.path();
            if !plain_address(address) {
                return Err(bad());
            }
            let fields: Vec<String> = url
                .query_pairs()
                .filter_map(|(k, v)| {
                    let k = k.to_ascii_lowercase();
                    MAILTO_FIELDS.contains(&k.as_str()).then(|| format!("{k}={}", encode(&v)))
                })
                .collect();
            Ok(if fields.is_empty() { format!("mailto:{address}") } else { format!("mailto:{address}?{}", fields.join("&")) })
        }
        _ => Err(bad()),
    }
}

/// `@` antes do fim da autoridade (`https://:@host` tem userinfo vazio, mas tem `@`).
fn rest_has_at(lower: &str) -> bool {
    let authority = lower.split_once("://").map_or("", |(_, r)| r.split(['/', '?', '#']).next().unwrap_or(""));
    authority.contains('@')
}

/// Link reconstruído e o host em ASCII (punycode), para a interface mostrar e decidir se confirma.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub href: String,
    /// Só em `http(s)`.
    pub host: Option<String>,
    /// Host internacionalizado (pode imitar outro site): a interface pede confirmação.
    pub idn: bool,
}

pub fn link_info(text: &str) -> AppResult<LinkInfo> {
    let href = safe_link(text.trim())?;
    let host = url::Url::parse(&href)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .and_then(|u| u.host_str().map(str::to_string));
    let idn = host.as_deref().is_some_and(|h| h.split('.').any(|label| label.starts_with("xn--")));
    Ok(LinkInfo { href, host, idn })
}

/// Destino normalizado de um link lido da imagem (o mesmo que `open_web` abriria).
#[tauri::command]
pub fn inspect_link(text: String) -> AppResult<LinkInfo> {
    link_info(&text)
}

/// Abre Traduzir, Pesquisar Texto, Pesquisar Imagem (página de busca por imagem, sem enviar nada)
/// ou um link/e-mail/telefone detectado, no navegador do sistema.
#[tauri::command]
pub fn open_web(app: AppHandle, kind: String, text: String, lang: String) -> AppResult<()> {
    let url = web_url(&kind, &text, &lang)?;
    app.opener().open_url(url, None::<&str>).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_das_consultas() {
        assert_eq!(
            web_url("translate", " Ação & café ", "en").unwrap(),
            "https://translate.google.com/?sl=auto&tl=en&text=A%C3%A7%C3%A3o%20%26%20caf%C3%A9&op=translate"
        );
        assert_eq!(web_url("search", "a+b", "x").unwrap(), "https://www.google.com/search?q=a%2Bb");
        assert_eq!(web_url("translate", "x", "pt-BR&q=1").unwrap(), web_url("translate", "x", "pt-BRq1").unwrap());
        assert_eq!(web_url("images", "", "").unwrap(), "https://images.google.com/");
    }

    #[test]
    fn link_so_aceita_esquemas_seguros() {
        assert!(web_url("link", "https://exemplo.com.br", "").is_ok());
        assert!(web_url("link", "mailto:a@b.com", "").is_ok());
        assert!(web_url("link", "tel:+5511987654321", "").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "exemplo.com", "https://a b", "smb://x"] {
            assert_eq!(web_url("link", bad, "").unwrap_err().code(), "unsupported", "{bad}");
        }
        assert!(web_url("outro", "x", "").is_err());
    }

    /// O texto vem da imagem (não confiável): o link é reconstruído, nunca repassado cru.
    #[test]
    fn mailto_so_leva_endereco_e_campos_permitidos() {
        let link = |s: &str| web_url("link", s, "");
        assert_eq!(
            link("mailto:ana@exemplo.com.br?subject=Oi%20a&attach=/etc/passwd&body=x&attachment=~/.ssh/id_rsa").unwrap(),
            "mailto:ana@exemplo.com.br?subject=Oi%20a&body=x"
        );
        assert_eq!(link("MAILTO:a@b.com?cc=c@d.com&bcc=e@f.com&X-Evil=1").unwrap(), "mailto:a@b.com?cc=c%40d.com&bcc=e%40f.com");
        assert_eq!(link("mailto:a@b.com?ATTACH=/x").unwrap(), "mailto:a@b.com");
        for bad in ["mailto:", "mailto:?attach=/etc/passwd", "mailto:/etc/passwd", "mailto:a@b.com,c@d.com", "mailto:a@b@c"] {
            assert!(link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tel_so_aceita_digitos_e_pontuacao() {
        let link = |s: &str| web_url("link", s, "");
        assert_eq!(link("tel:+55 (11) 98765-4321").unwrap(), "tel:+55(11)98765-4321");
        assert_eq!(link("tel:11987654321").unwrap(), "tel:11987654321");
        for bad in ["tel:", "tel:123;phone-context=x", "tel:123?x=1", "tel:abc", "tel:12%0A3", "tel:()"] {
            assert!(link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn http_exige_host_valido() {
        let link = |s: &str| web_url("link", s, "");
        assert_eq!(link("https://exemplo.com.br/a?b=1").unwrap(), "https://exemplo.com.br/a?b=1");
        assert_eq!(link("HTTP://Exemplo.com").unwrap(), "http://exemplo.com/");
        for bad in ["https:///etc/passwd", "http://", "https://a b", "https://", "http:exemplo"] {
            assert!(link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn http_com_userinfo_e_recusado() {
        for bad in ["https://usuario@exemplo.com", "https://a:b@exemplo.com/x", "http://google.com@evil.example/", "https://:@exemplo.com"] {
            assert!(web_url("link", bad, "").is_err(), "{bad}");
            assert!(link_info(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn link_info_devolve_host_ascii_e_marca_idn() {
        let ascii = link_info("https://Exemplo.com.br/a").unwrap();
        assert_eq!((ascii.href.as_str(), ascii.host.as_deref(), ascii.idn), ("https://exemplo.com.br/a", Some("exemplo.com.br"), false));
        let idn = link_info("https://exémplo.com/a").unwrap();
        assert_eq!(idn.host.as_deref(), Some("xn--exmplo-cva.com"));
        assert!(idn.idn);
        assert_eq!(idn.href, "https://xn--exmplo-cva.com/a");
        // Punycode já escrito também é IDN (homógrafo disfarçado).
        assert!(link_info("https://xn--pple-43d.com").unwrap().idn);
        let mail = link_info("mailto:a@b.com?attach=/x").unwrap();
        assert_eq!((mail.href.as_str(), mail.host, mail.idn), ("mailto:a@b.com", None, false));
        assert!(link_info("file:///etc/passwd").is_err());
    }

    #[test]
    fn status_sem_modelos_pede_o_download_inteiro() {
        let dir = std::env::temp_dir().join(format!("gvi-ocr-vazio-{}", std::process::id()));
        let s = models_status(&dir);
        assert!(!s.installed);
        assert_eq!(s.download_bytes, MODELS.iter().map(|m| m.size).sum::<u64>());
        assert_eq!(engine(&dir).err().map(|e| e.code()), Some("not_found"));
    }

    #[test]
    fn cache_guarda_a_ultima_revisao_por_documento() {
        let line = |t: &str| TextLine { text: t.into(), bbox: crate::doc::model::Rect { x: 0, y: 0, w: 0, h: 0 }, words: vec![] };
        remember((DocId(900), 0, 1), Arc::new(vec![line("a")]));
        remember((DocId(900), 0, 2), Arc::new(vec![line("b")]));
        assert!(cached((DocId(900), 0, 1)).is_none(), "revisão antiga sai");
        assert_eq!(cached((DocId(900), 0, 2)).unwrap()[0].text, "b");
        for i in 0..CACHE_LEN as u32 {
            remember((DocId(1000 + i), 0, 0), Arc::new(vec![]));
        }
        assert!(cached((DocId(900), 0, 2)).is_none(), "limite de entradas");
    }
}
