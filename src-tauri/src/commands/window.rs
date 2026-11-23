//! Lote 12 (Janelas e Abas): janelas de documento, passagem de documentos entre elas, fechar/sair
//! e Importar do Scanner (ainda um stub). A posse dos documentos está em `doc::windows`.
//!
//! A janela que age é sempre a que chamou (`WebviewWindow`, dada pelo Tauri); rótulos recebidos da
//! interface só valem se forem de uma janela de documento viva.
use super::{blocking, not_yet};
use crate::{
    doc::{
        model::{DocId, DocInfo},
        store::DocStore,
        windows::{Seal, WindowRegistry},
    },
    error::{AppError, AppResult},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    ipc::{Invoke, InvokeBody},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Há documentos na caixa da janela (`take_documents`).
pub const INCOMING_EVENT: &str = "docs-incoming";
/// Juntar Todas as Janelas: mande seus documentos para a janela do payload.
pub const MERGE_EVENT: &str = "merge-request";
/// Sair: pergunte pelas alterações e responda com `answer_close` (o payload é a rodada).
pub const CONFIRM_CLOSE_EVENT: &str = "confirm-close";
/// A saída desta rodada foi cancelada: volte ao normal.
pub const QUIT_CANCELLED_EVENT: &str = "quit-cancelled";
/// Feche a janela, perguntando pelas alterações (Fechar Todas).
pub const CLOSE_EVENT: &str = "close-window";
/// Ative o documento: o arquivo pedido em outra janela já está aberto nesta.
pub const ACTIVATE_EVENT: &str = "activate-document";
/// A lista de janelas ou um título mudou: a lista nova (vai para todas).
pub const CHANGED_EVENT: &str = "windows-changed";
/// Responda com `pong` (a interface está viva).
pub const PING_EVENT: &str = "ping-window";
/// A janela do payload não pôde ser juntada.
pub const MERGE_DECLINED_EVENT: &str = "merge-declined";

/// Prazo para uma interface viva responder ao ping.
const PING_TIMEOUT: Duration = Duration::from_secs(3);
/// Prazo para uma janela nova abrir antes de o Sair desistir (avisando).
const OPENING_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TITLE: usize = 256;
/// Título de uma janela sem documento (`tauri.conf.json`).
const APP_TITLE: &str = "Gera View Image";

fn io(e: impl std::fmt::Display) -> AppError {
    AppError::Io(e.to_string())
}

// ---------- posse dos documentos ----------

/// Ids de documento nos argumentos de um comando: `id`, `ids` e `items[].id` (arraste).
pub fn doc_ids(args: &Value) -> Vec<DocId> {
    let id = |v: &Value| v.as_u64().and_then(|n| u32::try_from(n).ok()).map(DocId);
    let list = |key: &str| args.get(key).and_then(Value::as_array).into_iter().flatten();
    args.get("id")
        .and_then(id)
        .into_iter()
        .chain(list("ids").filter_map(id))
        .chain(list("items").filter_map(|i| i.get("id").and_then(id)))
        .collect()
}

/// Recusa comandos sobre documentos de outra janela. Fica na frente de todos os comandos do app,
/// então vale também para os que vierem depois.
fn allowed(invoke: &Invoke) -> AppResult<()> {
    let InvokeBody::Json(args) = invoke.message.payload() else {
        return Ok(());
    };
    let webview = invoke.message.webview_ref();
    let (registry, store) = (webview.state::<WindowRegistry>(), webview.state::<DocStore>());
    for id in doc_ids(args) {
        // O caso comum (a dona) não toca no `DocStore`. Documento que não existe: o próprio comando
        // responde "não encontrado".
        if !registry.owns(webview.label(), id) && store.info(id).is_ok() {
            registry.access(webview.label(), id)?;
        }
    }
    Ok(())
}

/// Envolve o `generate_handler!` com [`allowed`].
pub fn guard<F>(handler: F) -> impl Fn(Invoke) -> bool + Send + Sync + 'static
where
    F: Fn(Invoke) -> bool + Send + Sync + 'static,
{
    move |invoke| match allowed(&invoke) {
        Ok(()) => handler(invoke),
        Err(e) => {
            invoke.resolver.reject(e);
            true
        }
    }
}

/// Documentos recém-criados passam a ser de `label`. Devolve o estado atual deles: um
/// `doc-updated` anterior à posse não foi para ninguém. Se a janela já fechou, fecha-os.
fn claim_for(
    registry: &WindowRegistry,
    store: &DocStore,
    label: &str,
    infos: Vec<DocInfo>,
) -> AppResult<Vec<DocInfo>> {
    let ids: Vec<DocId> = infos.iter().map(|i| i.id).collect();
    if let Err(e) = registry.claim(label, &ids) {
        ids.into_iter().for_each(|id| drop(store.close(id)));
        return Err(e);
    }
    Ok(infos.into_iter().map(|i| store.info(i.id).unwrap_or(i)).collect())
}

/// Documentos que um comando acabou de criar passam a ser da janela que o chamou.
pub fn claimed(window: &WebviewWindow, infos: Vec<DocInfo>) -> AppResult<Vec<DocInfo>> {
    claim_for(&window.state::<WindowRegistry>(), &window.state::<DocStore>(), window.label(), infos)
}

/// [`claimed`] para um documento só.
pub fn claimed_one(window: &WebviewWindow, info: DocInfo) -> AppResult<DocInfo> {
    let fallback = info.clone();
    Ok(claimed(window, vec![info])?.pop().unwrap_or(fallback))
}

/// Manda o evento só para a janela dona do documento.
pub fn emit_to_owner<T: Serialize + Clone>(app: &AppHandle, id: DocId, event: &str, payload: T) {
    if let Some(label) = app.state::<WindowRegistry>().owner(id) {
        let _ = app.emit_to(label, event, payload);
    }
}

// ---------- janelas ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowEntry {
    pub label: String,
    pub title: String,
}

/// Janelas abertas, na ordem de criação, com o último título que cada uma informou.
fn entries(registry: &WindowRegistry) -> Vec<WindowEntry> {
    let named = |title: String| if title.is_empty() { APP_TITLE.to_string() } else { title };
    registry
        .titles()
        .into_iter()
        .map(|(label, title)| WindowEntry { label, title: named(title) })
        .collect()
}

/// Avisa todas as janelas da lista nova.
fn windows_changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, entries(&app.state::<WindowRegistry>()));
}

/// Cria a janela com a configuração da principal (`tauri.conf.json`, já ajustada por
/// `apply_safe_window`): transparente, sem decoração, opaca no modo de segurança.
fn build_window(app: &AppHandle, label: &str) -> AppResult<()> {
    let mut config = app.config().app.windows.first().cloned().unwrap_or_default();
    config.label = label.to_string();
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(io)?;
    super::camera::install(&window);
    Ok(())
}

fn raise(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn others(registry: &WindowRegistry, window: &WebviewWindow) -> Vec<String> {
    registry.labels().into_iter().filter(|l| l != window.label()).collect()
}

/// Abre uma janela com estes documentos (Mover Aba para Nova Janela); devolve o rótulo dela.
#[tauri::command]
pub async fn new_window(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    ids: Vec<DocId>,
    state: String,
) -> AppResult<String> {
    let label = registry.create();
    let made = registry
        .transfer(window.label(), &label, ids, state)
        .and_then(|()| build_window(&app, &label));
    if let Err(e) = made {
        registry.undo_create(&label, window.label());
        return Err(e);
    }
    windows_changed(&app);
    Ok(label)
}

/// Passa documentos desta janela para outra (Juntar Todas as Janelas).
#[tauri::command]
pub async fn move_documents(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    ids: Vec<DocId>,
    to: String,
    state: String,
) -> AppResult<()> {
    registry.transfer(window.label(), &to, ids, state)?;
    // Sem ouvinte ainda (janela abrindo), ela retira a caixa ao terminar de carregar.
    let _ = app.emit_to(to, INCOMING_EVENT, ());
    Ok(())
}

/// Entrega retirada por `take_documents`.
#[derive(Debug, Clone, Serialize)]
pub struct Incoming {
    pub infos: Vec<DocInfo>,
    pub state: String,
}

#[tauri::command]
pub async fn take_documents(
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    store: State<'_, DocStore>,
) -> AppResult<Vec<Incoming>> {
    let taken = registry.take(window.label())?;
    Ok(taken
        .into_iter()
        .map(|h| Incoming {
            infos: h.ids.iter().filter_map(|id| store.info(*id).ok()).collect(),
            state: h.state,
        })
        .collect())
}

#[tauri::command]
pub async fn list_windows(registry: State<'_, WindowRegistry>) -> AppResult<Vec<WindowEntry>> {
    Ok(entries(&registry))
}

/// Texto de título sem caracteres de controle e de tamanho razoável (vem do nome do arquivo).
fn clean_title(title: &str) -> String {
    title.chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect()
}

/// Título da janela que chamou (menu Janela, barra de tarefas).
#[tauri::command]
pub async fn set_window_title(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    title: String,
) -> AppResult<()> {
    let title = clean_title(&title);
    window.set_title(&title).map_err(io)?;
    registry.set_title(window.label(), title)?;
    windows_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn focus_window(app: AppHandle, registry: State<'_, WindowRegistry>, label: String) -> AppResult<()> {
    registry.check(&label)?;
    raise(&app, &label);
    Ok(())
}

/// Trazer Tudo para a Frente; a janela que pediu fica por cima.
#[tauri::command]
pub async fn bring_all_to_front(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
) -> AppResult<()> {
    for label in others(&registry, &window) {
        raise(&app, &label);
    }
    raise(&app, window.label());
    Ok(())
}

/// Juntar Todas as Janelas: pede às outras que mandem seus documentos para a que chamou.
#[tauri::command]
pub async fn merge_windows(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
) -> AppResult<()> {
    registry.check(window.label())?;
    for label in others(&registry, &window) {
        let _ = app.emit_to(label, MERGE_EVENT, window.label());
    }
    Ok(())
}

/// Juntar Todas as Janelas: esta não pode ir agora; avisa quem pediu.
#[tauri::command]
pub async fn decline_merge(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    store: State<'_, DocStore>,
    to: String,
) -> AppResult<()> {
    registry.check(&to)?;
    let _ = app.emit_to(to, MERGE_DECLINED_EVENT, title_of(&registry, &store, window.label()));
    Ok(())
}

/// Dos caminhos, os que não estão abertos em outra janela. Com `focus`, traz para a frente a janela
/// dos outros, com o documento ativo.
#[tauri::command]
pub async fn focus_open_paths(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    store: State<'_, DocStore>,
    paths: Vec<String>,
    focus: bool,
) -> AppResult<Vec<String>> {
    let mut open: Vec<(String, DocId, String)> = Vec::new();
    for label in others(&registry, &window) {
        for id in registry.owned(&label) {
            if let Ok(info) = store.info(id)
                && !info.path.is_empty()
            {
                open.push((label.clone(), id, info.path));
            }
        }
    }
    let matched = blocking(move || Ok(match_open(open, paths))).await?;
    let mut rest = Vec::new();
    for (path, found) in matched {
        let Some((label, id)) = found else {
            rest.push(path);
            continue;
        };
        if focus {
            raise(&app, &label);
            let _ = app.emit_to(label, ACTIVATE_EVENT, id);
        }
    }
    Ok(rest)
}

/// Cada caminho pedido, com a janela e o documento que já o têm aberto (links simbólicos resolvidos).
fn match_open(open: Vec<(String, DocId, String)>, paths: Vec<String>) -> Vec<(String, Option<(String, DocId)>)> {
    let real = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| Path::new(p).to_path_buf());
    let mut by_path = HashMap::new();
    for (label, id, path) in open {
        by_path.entry(real(&path)).or_insert((label, id));
    }
    let find = |p: String| {
        let found = by_path.get(&real(&p)).cloned();
        (p, found)
    };
    paths.into_iter().map(find).collect()
}

// ---------- fechar e sair ----------

/// Tudo perguntado: a janela vai fechar e não recebe mais documentos. `false` = chegaram
/// documentos nesse meio-tempo (retire-os e pergunte de novo). `quit` é a rodada da saída com que
/// ela concorda; sem ele, é ela que está fechando.
#[tauri::command]
pub async fn seal_window(
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    quit: Option<u64>,
) -> AppResult<bool> {
    registry.seal(window.label(), quit.map_or(Seal::Close, Seal::Quit))
}

#[tauri::command]
pub async fn unseal_window(window: WebviewWindow, registry: State<'_, WindowRegistry>) -> AppResult<()> {
    registry.unseal(window.label());
    Ok(())
}

/// Fecha a janela que chamou, já selada.
#[tauri::command]
pub async fn close_window(window: WebviewWindow, registry: State<'_, WindowRegistry>) -> AppResult<()> {
    if !registry.is_sealed(window.label()) {
        return Err(AppError::Unsupported("fechar sem perguntar".into()));
    }
    window.destroy().map_err(io)
}

/// Fechar Todas: cada uma das outras janelas pergunta pelas próprias alterações e se fecha.
#[tauri::command]
pub async fn close_other_windows(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
) -> AppResult<()> {
    for label in others(&registry, &window) {
        raise(&app, &label);
        let _ = app.emit_to(label, CLOSE_EVENT, ());
    }
    Ok(())
}

struct Asking {
    label: String,
    answer: tauri::async_runtime::Sender<bool>,
}

#[derive(Default)]
struct QuitState {
    /// Conta as saídas pedidas: respostas e cancelamentos de uma rodada não valem para outra.
    round: u64,
    active: bool,
    asking: Option<Asking>,
}

/// Saída em andamento: uma de cada vez, perguntando a uma janela de cada vez.
#[derive(Default)]
pub struct Quitting(Mutex<QuitState>);

impl Quitting {
    fn lock(&self) -> MutexGuard<'_, QuitState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Começa uma rodada; `None` se já há uma.
    fn begin(&self) -> Option<u64> {
        let mut s = self.lock();
        if s.active {
            return None;
        }
        s.active = true;
        s.round += 1;
        Some(s.round)
    }

    /// Encerra a rodada; `false` se ela já tinha sido cancelada.
    fn finish(&self, round: u64) -> bool {
        let mut s = self.lock();
        let current = s.active && s.round == round;
        if current {
            s.active = false;
            s.asking = None;
        }
        current
    }

    /// Começa a perguntar a `label`; `None` se a rodada foi cancelada.
    fn ask(&self, round: u64, label: &str) -> Option<tauri::async_runtime::Receiver<bool>> {
        let mut s = self.lock();
        if !s.active || s.round != round || s.asking.is_some() {
            return None;
        }
        let (answer, rx) = tauri::async_runtime::channel(1);
        s.asking = Some(Asking { label: label.to_string(), answer });
        Some(rx)
    }

    /// Resposta da janela perguntada, nesta rodada; qualquer outra é ignorada (`false`).
    fn reply(&self, label: &str, round: u64, ok: bool) -> bool {
        let mut s = self.lock();
        s.round == round && s.answer(label, ok)
    }

    /// A janela não existe mais: nada a perguntar a ela.
    fn gone(&self, label: &str) {
        self.lock().answer(label, true);
    }

    /// Cancela a rodada em andamento (ou a que acabou de terminar) e a devolve.
    fn cancel(&self) -> u64 {
        let mut s = self.lock();
        s.active = false;
        if let Some(a) = s.asking.take() {
            let _ = a.answer.try_send(false);
        }
        s.round
    }

    fn asking(&self) -> Option<String> {
        self.lock().asking.as_ref().map(|a| a.label.clone())
    }
}

impl QuitState {
    fn answer(&mut self, label: &str, ok: bool) -> bool {
        self.asking.take_if(|a| a.label == label).is_some_and(|a| a.answer.try_send(ok).is_ok())
    }
}

/// Respostas das interfaces ao `ping-window`.
#[derive(Clone, Default)]
pub struct Pongs(Arc<(Mutex<PongState>, Condvar)>);

#[derive(Default)]
struct PongState {
    sent: u64,
    /// Último ping respondido por janela.
    seen: HashMap<String, u64>,
}

impl Pongs {
    fn lock(&self) -> MutexGuard<'_, PongState> {
        self.0.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn next(&self) -> u64 {
        let mut s = self.lock();
        s.sent += 1;
        s.sent
    }

    fn pong(&self, label: &str, n: u64) {
        self.lock().seen.insert(label.to_string(), n);
        self.0.1.notify_all();
    }

    /// Espera o ping `n` de todas; devolve as que não responderam no prazo.
    fn wait(&self, labels: &[String], n: u64, timeout: Duration) -> Vec<String> {
        let missing = |s: &PongState| -> Vec<String> {
            labels.iter().filter(|l| s.seen.get(*l).is_none_or(|got| *got < n)).cloned().collect()
        };
        let (s, _) = self
            .0
            .1
            .wait_timeout_while(self.lock(), timeout, |s| !missing(s).is_empty())
            .unwrap_or_else(|e| e.into_inner());
        missing(&s)
    }
}

/// A interface está viva.
#[tauri::command]
pub async fn pong(window: WebviewWindow, pongs: State<'_, Pongs>, n: u64) -> AppResult<()> {
    pongs.pong(window.label(), n);
    Ok(())
}

/// Das janelas `labels`, as que existem e cuja interface não responde.
async fn unresponsive(app: &AppHandle, labels: Vec<String>) -> Vec<String> {
    let pongs = app.state::<Pongs>().inner().clone();
    let n = pongs.next();
    for label in &labels {
        let _ = app.emit_to(label, PING_EVENT, n);
    }
    let missing = blocking(move || Ok(pongs.wait(&labels, n, PING_TIMEOUT))).await.unwrap_or_default();
    let registry = app.state::<WindowRegistry>();
    missing.into_iter().filter(|l| registry.check(l).is_ok()).collect()
}

/// Espera as janelas que ainda abrem com documentos; devolve a primeira que não abriu no prazo.
async fn still_opening(app: &AppHandle, registry: &WindowRegistry) -> Option<String> {
    if registry.opening().is_empty() {
        return None;
    }
    let app = app.clone();
    let wait = move || {
        let registry = app.state::<WindowRegistry>();
        let end = Instant::now() + OPENING_TIMEOUT;
        while Instant::now() < end && !registry.opening().is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(registry.opening().into_iter().next())
    };
    blocking(wait).await.unwrap_or_default()
}

/// Próxima janela a perguntar ao sair: a que pediu e depois as outras, até todas estarem seladas.
fn next_to_ask(registry: &WindowRegistry, first: &str) -> Option<String> {
    let mut open: Vec<String> = registry.labels().into_iter().filter(|l| !registry.is_sealed(l)).collect();
    let at = open.iter().position(|l| l == first).unwrap_or(0);
    (!open.is_empty()).then(|| open.swap_remove(at))
}

/// Como terminou o `confirm_quit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuitOutcome {
    /// Todas concordaram (e ficam seladas).
    Agreed,
    Cancelled,
    /// Uma janela com documentos a caminho não terminou de abrir.
    Opening { title: String },
    /// A interface desta janela não responde: sair sem ela é escolha do usuário (`skip`).
    Unresponsive { label: String, title: String },
}

/// Nome da janela para o usuário: o título, ou o documento que ela ainda vai mostrar.
fn title_of(registry: &WindowRegistry, store: &DocStore, label: &str) -> String {
    let title = registry.titles().into_iter().find(|(l, t)| l == label && !t.is_empty()).map(|(_, t)| t);
    let doc = || registry.owned(label).first().and_then(|id| store.info(*id).ok()).map(|i| i.name);
    title.or_else(doc).unwrap_or_else(|| APP_TITLE.to_string())
}

/// Sair ou reiniciar: pergunta a cada janela pelas alterações, uma de cada vez; no primeiro
/// Cancelar, nada fecha nem é descartado. `skip`: janelas que não respondem e o usuário decidiu não
/// esperar (só valem se continuarem sem responder).
#[tauri::command]
pub async fn confirm_quit(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    store: State<'_, DocStore>,
    quitting: State<'_, Quitting>,
    skip: Vec<String>,
) -> AppResult<QuitOutcome> {
    if let Some(label) = quitting.asking() {
        if unresponsive(&app, vec![label.clone()]).await.is_empty() {
            raise(&app, &label);
            return Ok(QuitOutcome::Cancelled);
        }
        release_all(&app, &registry, quitting.cancel());
    }
    let Some(round) = quitting.begin() else {
        return Ok(QuitOutcome::Cancelled);
    };
    let mut out = ask_all(&app, &registry, &store, &quitting, window.label(), round, &skip).await;
    if !quitting.finish(round) {
        out = QuitOutcome::Cancelled;
    }
    if out != QuitOutcome::Agreed {
        release_all(&app, &registry, round);
    }
    Ok(out)
}

async fn ask_all(
    app: &AppHandle,
    registry: &WindowRegistry,
    store: &DocStore,
    quitting: &Quitting,
    first: &str,
    round: u64,
    skip: &[String],
) -> QuitOutcome {
    // Antes de perguntar a qualquer uma: ninguém responde à toa.
    if let Some(label) = still_opening(app, registry).await {
        return QuitOutcome::Opening { title: title_of(registry, store, &label) };
    }
    let ready = registry.labels().into_iter().filter(|l| l != first && registry.is_ready(l)).collect();
    for label in unresponsive(app, ready).await {
        if !skip.contains(&label) {
            return QuitOutcome::Unresponsive { title: title_of(registry, store, &label), label };
        }
        let _ = registry.force_seal(&label, round);
    }
    while let Some(label) = next_to_ask(registry, first) {
        let agreed = ask(app, registry, quitting, round, &label).await;
        // Uma resposta sim sem selo não vale (senão a pergunta se repetiria para sempre).
        if !agreed || (registry.check(&label).is_ok() && !registry.is_sealed(&label)) {
            return QuitOutcome::Cancelled;
        }
    }
    QuitOutcome::Agreed
}

async fn ask(app: &AppHandle, registry: &WindowRegistry, quitting: &Quitting, round: u64, label: &str) -> bool {
    if !registry.is_ready(label) {
        // Ainda abrindo: só há o que perder se houver documentos a caminho.
        return registry.seal(label, Seal::Quit(round)).unwrap_or(true);
    }
    let Some(mut answer) = begin_ask(registry, quitting, round, label) else {
        return false;
    };
    raise(app, label);
    if app.emit_to(label, CONFIRM_CLOSE_EVENT, round).is_err() {
        quitting.reply(label, round, false);
    }
    answer.recv().await.unwrap_or(false)
}

/// Registra a pergunta. Uma janela destruída antes disso não teria quem respondesse por ela.
fn begin_ask(
    registry: &WindowRegistry,
    quitting: &Quitting,
    round: u64,
    label: &str,
) -> Option<tauri::async_runtime::Receiver<bool>> {
    let answer = quitting.ask(round, label)?;
    if registry.check(label).is_err() {
        quitting.gone(label);
    }
    Some(answer)
}

/// Desfaz o selo da saída e devolve a janela ao normal.
fn release(app: &AppHandle, registry: &WindowRegistry, label: &str, round: u64) {
    registry.unseal_quit(label, round);
    let _ = app.emit_to(label, QUIT_CANCELLED_EVENT, round);
}

fn release_all(app: &AppHandle, registry: &WindowRegistry, round: u64) {
    registry.labels().iter().for_each(|label| release(app, registry, label, round));
}

/// Resposta da janela ao `confirm-close`. O sim só vale com a janela selada; se a saída já foi
/// cancelada, a janela volta ao normal.
#[tauri::command]
pub async fn answer_close(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    quitting: State<'_, Quitting>,
    round: u64,
    ok: bool,
) -> AppResult<()> {
    let label = window.label();
    let accepted = quitting.reply(label, round, ok && registry.is_sealed(label));
    if ok && !accepted {
        release(&app, &registry, label, round);
    }
    Ok(())
}

/// A saída confirmada não aconteceu (o reinício falhou) ou foi cancelada numa janela que já tinha
/// concordado: as janelas voltam ao normal.
#[tauri::command]
pub async fn cancel_quit(
    app: AppHandle,
    registry: State<'_, WindowRegistry>,
    quitting: State<'_, Quitting>,
) -> AppResult<()> {
    release_all(&app, &registry, quitting.cancel());
    Ok(())
}

/// Sai do app depois de um `confirm_quit` verdadeiro.
#[tauri::command]
pub async fn quit_app(app: AppHandle, registry: State<'_, WindowRegistry>) -> AppResult<()> {
    if registry.labels().iter().any(|l| !registry.is_sealed(l)) {
        return Err(AppError::Unsupported("sair sem perguntar".into()));
    }
    app.exit(0);
    Ok(())
}

/// Fechar esta janela agora perderia documentos que ela ainda nem mostrou?
fn strands_documents(registry: &WindowRegistry, label: &str) -> bool {
    !registry.is_ready(label) && registry.has_inbox(label) && !registry.has_open_besides(label)
}

/// Texto da interface para um diálogo do sistema (a página não abriu, então não há `t()`).
fn text(locale: &str, key: &str) -> String {
    let file = if locale.starts_with("pt") {
        include_str!("../../../src/i18n/pt-BR.json")
    } else {
        include_str!("../../../src/i18n/en.json")
    };
    let all: Value = serde_json::from_str(file).unwrap_or_default();
    key.split('.').fold(&all, |v, k| &v[k]).as_str().unwrap_or(key).to_string()
}

fn system_locale() -> String {
    let var = |k| std::env::var(k).ok().filter(|v| !v.is_empty());
    var("LC_ALL").or_else(|| var("LC_MESSAGES")).or_else(|| var("LANG")).unwrap_or_default()
}

/// Pergunta, pelo sistema, se fecha a janela que não terminou de abrir.
fn confirm_stranded(app: &AppHandle, label: &str) {
    static ASKING: AtomicBool = AtomicBool::new(false);
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let locale = system_locale();
    let t = |k: &str| text(&locale, &format!("tabs.stuck.{k}"));
    let (handle, label) = (app.clone(), label.to_string());
    app.dialog()
        .message(t("body"))
        .title(t("title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(t("close"), t("cancel")))
        .show(move |close| {
            ASKING.store(false, Ordering::SeqCst);
            // Abriu enquanto se perguntava: agora ela mesma pergunta.
            if close
                && !handle.state::<WindowRegistry>().is_ready(&label)
                && let Some(w) = handle.get_webview_window(&label)
            {
                let _ = w.destroy();
            }
        });
}

/// Eventos das janelas (instalado uma vez no `Builder`).
pub fn on_event(window: &tauri::Window, event: &WindowEvent) {
    let (app, label) = (window.app_handle(), window.label());
    let registry = app.state::<WindowRegistry>();
    match event {
        // Fechada antes de a interface abrir, com documentos a caminho: eles voltam para outra
        // janela (`Destroyed`). Sem outra, é o único lugar em que estão: só fecha se confirmarem.
        WindowEvent::CloseRequested { api, .. } if strands_documents(&registry, label) => {
            api.prevent_close();
            confirm_stranded(app, label);
        }
        WindowEvent::Destroyed if registry.check(label).is_ok() => {
            let removed = registry.remove(label);
            let store = app.state::<DocStore>();
            removed.close.into_iter().for_each(|id| drop(store.close(id)));
            for to in removed.returned_to {
                let _ = app.emit_to(to, INCOMING_EVENT, ());
            }
            app.state::<Quitting>().gone(label);
            super::camera::forget(label);
            super::ocr::cancel(label);
            super::segment::cancel(label);
            windows_changed(app);
        }
        _ => {}
    }
}

/// Importar do Scanner (SANE); `None` = cancelado.
#[tauri::command]
pub fn scan_image(name: String) -> AppResult<Option<DocInfo>> {
    let _ = name;
    not_yet("scan_image")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        doc::{
            model::{Op, SourceFormat},
            windows::MAIN_WINDOW,
        },
        image::decode::Decoded,
    };
    use ::image::RgbaImage;
    use serde_json::json;

    fn store_with(n: usize) -> (DocStore, Vec<DocInfo>) {
        let store = DocStore::new();
        let blank = || Decoded::single(RgbaImage::new(2, 2), SourceFormat::Png);
        let infos = (0..n).map(|_| store.insert_decoded("", blank())).collect();
        (store, infos)
    }

    #[test]
    fn acha_os_ids_nos_argumentos_dos_comandos() {
        assert_eq!(doc_ids(&json!({ "id": 3, "op": { "id": 9 } })), [DocId(3)]);
        assert_eq!(doc_ids(&json!({ "ids": [1, 2], "dest": "/x" })), [DocId(1), DocId(2)]);
        assert_eq!(doc_ids(&json!({ "items": [{ "id": 4, "export": true }] })), [DocId(4)]);
        assert!(doc_ids(&json!({ "paths": ["/x"], "id": "7" })).is_empty());
        assert!(doc_ids(&json!({ "id": -1, "ids": [5_000_000_000u64, "a"] })).is_empty());
        assert!(doc_ids(&Value::Null).is_empty());
    }

    #[test]
    fn documento_criado_e_da_janela_que_pediu() {
        let (store, infos) = store_with(2);
        let registry = WindowRegistry::default();
        let got = claim_for(&registry, &store, MAIN_WINDOW, infos).unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|i| registry.owner(i.id).as_deref() == Some(MAIN_WINDOW)));
    }

    #[test]
    fn documento_devolvido_traz_o_que_mudou_antes_da_posse() {
        let (store, infos) = store_with(1);
        store.apply_op(infos[0].id, Op::FlipH).unwrap();
        let got = claim_for(&WindowRegistry::default(), &store, MAIN_WINDOW, infos).unwrap();
        assert_eq!(got[0].rev, 1);
    }

    #[test]
    fn janela_que_fechou_durante_a_abertura_nao_deixa_documento_orfao() {
        let (store, infos) = store_with(1);
        let id = infos[0].id;
        assert!(claim_for(&WindowRegistry::default(), &store, "doc-5", infos).is_err());
        assert!(store.info(id).is_err());
    }

    #[test]
    fn sair_pergunta_primeiro_a_janela_que_pediu_e_para_com_todas_seladas() {
        let r = WindowRegistry::default();
        let w = r.create();
        let mut order = vec![];
        while let Some(label) = next_to_ask(&r, &w) {
            r.seal(&label, Seal::Close).unwrap();
            // Janela aberta durante as perguntas também é perguntada.
            if order.is_empty() {
                r.create();
            }
            order.push(label);
        }
        assert_eq!(order, ["doc-1", "main", "doc-2"]);
    }

    #[test]
    fn so_a_janela_perguntada_responde_a_saida() {
        let q = Quitting::default();
        let round = q.begin().unwrap();
        assert!(q.begin().is_none(), "uma saída de cada vez");
        let mut rx = q.ask(round, "main").unwrap();
        assert!(q.ask(round, "doc-1").is_none(), "uma pergunta de cada vez");
        assert!(!q.reply("doc-1", round, true));
        assert!(!q.reply("main", round + 1, true));
        assert_eq!(q.asking().as_deref(), Some("main"));
        assert!(q.reply("main", round, false));
        assert_eq!(rx.blocking_recv(), Some(false));
        assert!(q.ask(round, "doc-1").is_some());
        assert!(q.finish(round));
        assert!(q.begin().is_some());
    }

    #[test]
    fn saida_cancelada_por_outra_janela_encerra_a_rodada() {
        let q = Quitting::default();
        let old = q.begin().unwrap();
        let mut rx = q.ask(old, "main").unwrap();
        assert_eq!(q.cancel(), old);
        assert_eq!(rx.blocking_recv(), Some(false));
        assert!(q.ask(old, "doc-1").is_none(), "nem a próxima janela é perguntada");
        assert!(!q.finish(old), "cancelada depois da última resposta não sai");
        // A resposta que chega depois não vale, nem para a rodada seguinte.
        assert!(!q.reply("main", old, true));
        let new = q.begin().unwrap();
        let _rx = q.ask(new, "main").unwrap();
        assert!(!q.reply("main", old, true));
        assert!(!q.finish(old));
        assert!(q.reply("main", new, true));
        assert!(q.finish(new));
        assert_eq!(q.cancel(), new, "o reinício falhou depois de todas concordarem");
    }

    #[test]
    fn janela_que_some_antes_da_pergunta_nao_prende_a_saida() {
        let registry = WindowRegistry::default();
        let w = registry.create();
        let q = Quitting::default();
        let round = q.begin().unwrap();
        registry.remove(&w);
        let mut rx = begin_ask(&registry, &q, round, &w).unwrap();
        assert_eq!(rx.try_recv(), Ok(true));
        let mut rx = begin_ask(&registry, &q, round, MAIN_WINDOW).unwrap();
        assert!(rx.try_recv().is_err(), "uma viva é esperada");
        q.gone(MAIN_WINDOW);
        assert_eq!(rx.try_recv(), Ok(true));
    }

    #[test]
    fn ping_diz_quem_nao_respondeu() {
        let pongs = Pongs::default();
        let labels = ["main".to_string(), "doc-1".to_string()];
        let n = pongs.next();
        pongs.pong("main", n);
        assert_eq!(pongs.wait(&labels, n, Duration::from_millis(20)), ["doc-1"]);
        let late = pongs.clone();
        let answer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            late.pong("doc-1", n);
        });
        let start = Instant::now();
        assert!(pongs.wait(&labels, n, Duration::from_secs(20)).is_empty());
        assert!(start.elapsed() < Duration::from_secs(10), "não espera o prazo todo");
        answer.join().unwrap();
        // Resposta de um ping anterior não vale.
        assert_eq!(pongs.wait(&labels, pongs.next(), Duration::from_millis(20)).len(), 2);
    }

    #[test]
    fn janela_que_nao_abriu_fecha_devolvendo_o_que_ia_chegar() {
        let r = WindowRegistry::default();
        r.claim(MAIN_WINDOW, &[DocId(1), DocId(2)]).unwrap();
        r.take(MAIN_WINDOW).unwrap();
        let w = r.create();
        assert!(!strands_documents(&r, &w), "nada a perder");
        r.transfer(MAIN_WINDOW, &w, vec![DocId(1)], "estado".into()).unwrap();
        assert!(!strands_documents(&r, &w), "volta para a principal");
        // Sem outra janela que receba, só com confirmação.
        r.seal(MAIN_WINDOW, Seal::Close).unwrap();
        assert!(strands_documents(&r, &w));
        r.take(&w).unwrap();
        assert!(!strands_documents(&r, &w), "aberta, ela mesma pergunta");
    }

    #[test]
    fn textos_do_dialogo_do_sistema_vem_da_traducao() {
        for k in ["title", "body", "close", "cancel"] {
            let key = format!("tabs.stuck.{k}");
            let (pt, en) = (text("pt_BR.UTF-8", &key), text("C", &key));
            assert!(pt != key && en != key && !pt.is_empty(), "{key}");
        }
        assert_eq!(text("pt_BR.UTF-8", "tabs.stuck.cancel"), "Cancelar");
        assert_eq!(text("", "tabs.stuck.cancel"), "Cancel");
    }

    #[test]
    fn nome_da_janela_e_o_titulo_ou_o_documento_que_vai_mostrar() {
        let (store, infos) = store_with(1);
        let r = WindowRegistry::default();
        assert_eq!(title_of(&r, &store, MAIN_WINDOW), APP_TITLE);
        r.claim(MAIN_WINDOW, &[infos[0].id]).unwrap();
        assert_eq!(title_of(&r, &store, MAIN_WINDOW), infos[0].name);
        r.set_title(MAIN_WINDOW, "praia.png".into()).unwrap();
        assert_eq!(title_of(&r, &store, MAIN_WINDOW), "praia.png");
    }

    #[test]
    fn resposta_da_saida_no_formato_da_interface() {
        let out = QuitOutcome::Unresponsive { label: "doc-1".into(), title: "a".into() };
        assert_eq!(json!(out), json!({ "kind": "unresponsive", "label": "doc-1", "title": "a" }));
        assert_eq!(json!(QuitOutcome::Agreed), json!({ "kind": "agreed" }));
    }

    #[test]
    fn a_lista_de_janelas_traz_o_ultimo_titulo_de_cada_uma() {
        let r = WindowRegistry::default();
        let w = r.create();
        r.set_title(&w, "praia.png".into()).unwrap();
        let of = |label: &str, title: &str| WindowEntry { label: label.into(), title: title.into() };
        assert_eq!(entries(&r), [of("main", APP_TITLE), of("doc-1", "praia.png")]);
        assert!(r.set_title("print", "x".into()).is_err());
    }

    #[test]
    fn titulo_nao_leva_caractere_de_controle_nem_tamanho_absurdo() {
        assert_eq!(clean_title("a\n\u{1b}b\u{7}.png"), "ab.png");
        assert_eq!(clean_title(&"á".repeat(5000)).chars().count(), MAX_TITLE);
    }

    #[test]
    fn acha_o_arquivo_aberto_em_outra_janela_mesmo_por_link() {
        let dir = std::env::temp_dir().join(format!("gvi-janelas-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (file, link, gone) = (dir.join("a.png"), dir.join("link.png"), dir.join("sumiu.png"));
        std::fs::write(&file, b"x").unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let text = |p: &Path| p.to_str().unwrap().to_string();
        let open = vec![("doc-1".to_string(), DocId(4), text(&file)), ("doc-2".to_string(), DocId(5), text(&gone))];
        let got = match_open(open, vec![text(&link), text(&gone), text(&dir.join("outra.png"))]);
        let found: Vec<_> = got.into_iter().map(|(_, f)| f).collect();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(found, [Some(("doc-1".into(), DocId(4))), Some(("doc-2".into(), DocId(5))), None]);
    }

    /// `doc_ids` só acha documentos em argumentos com estes nomes: um comando novo com outro nome
    /// passaria sem checagem de posse.
    #[test]
    fn todo_comando_recebe_documento_por_um_nome_conhecido() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut seen = 0;
        for file in std::fs::read_dir(dir).unwrap() {
            let file = file.unwrap().path();
            let src = std::fs::read_to_string(&file).unwrap();
            for cmd in src.split("#[tauri::command").skip(1) {
                let Some((_, from_name)) = cmd.split('{').next().and_then(|sig| sig.split_once("fn ")) else {
                    continue;
                };
                let params = from_name.split("->").next().unwrap();
                for (name, ty) in params.split(['(', ',', '\n']).filter_map(|p| p.split_once(':')) {
                    if ty.contains("DocId") || ty.contains("DragSource") {
                        seen += 1;
                        assert!(["id", "ids", "items"].contains(&name.trim()), "{}: {name}:{ty}", file.display());
                    }
                }
            }
        }
        assert!(seen > 40, "leu os comandos? ({seen})");
    }

    #[test]
    fn capability_vale_para_as_janelas_novas_sem_permissao_a_mais() {
        let capability: Value = serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], json!(["main", "doc-*"]));
        assert!(WindowRegistry::default().create().starts_with("doc-"));
    }
}
