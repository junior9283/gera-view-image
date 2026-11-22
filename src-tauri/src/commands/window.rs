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
        windows::WindowRegistry,
    },
    error::{AppError, AppResult},
};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::Mutex};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    ipc::{Invoke, InvokeBody},
};

/// Há documentos na caixa da janela (`take_documents`).
pub const INCOMING_EVENT: &str = "docs-incoming";
/// Juntar Todas as Janelas: mande seus documentos para a janela do payload.
pub const MERGE_EVENT: &str = "merge-request";
/// Sair: pergunte pelas alterações e responda com `answer_close`.
pub const CONFIRM_CLOSE_EVENT: &str = "confirm-close";
/// Sair foi cancelado: volte ao normal.
pub const QUIT_CANCELLED_EVENT: &str = "quit-cancelled";
/// Feche a janela, perguntando pelas alterações (Fechar Todas).
pub const CLOSE_EVENT: &str = "close-window";
/// Ative o documento: o arquivo pedido em outra janela já está aberto nesta.
pub const ACTIVATE_EVENT: &str = "activate-document";
/// A lista de janelas ou um título mudou: a lista nova (vai para todas).
pub const CHANGED_EVENT: &str = "windows-changed";

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

/// Manda o evento só para a janela dona do documento; `false` se ele ainda não tem dono.
pub fn emit_to_owner<T: Serialize + Clone>(app: &AppHandle, id: DocId, event: &str, payload: T) -> bool {
    let owner = app.state::<WindowRegistry>().owner(id);
    owner.is_some_and(|label| app.emit_to(label, event, payload).is_ok())
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

/// Arquivos já abertos em outra janela: traz essa janela para a frente com o documento ativo e
/// devolve só os caminhos que faltam abrir.
#[tauri::command]
pub async fn focus_open_paths(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    store: State<'_, DocStore>,
    paths: Vec<String>,
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
        raise(&app, &label);
        let _ = app.emit_to(label, ACTIVATE_EVENT, id);
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
/// documentos nesse meio-tempo (retire-os e pergunte de novo).
#[tauri::command]
pub async fn seal_window(window: WebviewWindow, registry: State<'_, WindowRegistry>) -> AppResult<bool> {
    registry.seal(window.label())
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
        let _ = app.emit_to(label, CLOSE_EVENT, ());
    }
    Ok(())
}

struct Asking {
    label: String,
    answer: tauri::async_runtime::Sender<bool>,
}

/// Pergunta de saída em andamento (uma de cada vez).
#[derive(Default)]
pub struct Quitting(Mutex<Option<Asking>>);

impl Quitting {
    /// Começa a perguntar a `label`; `None` se outra pergunta já está em andamento.
    fn ask(&self, label: &str) -> Option<tauri::async_runtime::Receiver<bool>> {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.is_some() {
            return None;
        }
        let (answer, rx) = tauri::async_runtime::channel(1);
        *s = Some(Asking { label: label.to_string(), answer });
        Some(rx)
    }

    /// Resposta da janela perguntada; de qualquer outra, é ignorada (`false`).
    fn reply(&self, label: &str, ok: bool) -> bool {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let asked = s.take_if(|a| a.label == label);
        asked.is_some_and(|a| a.answer.try_send(ok).is_ok())
    }

    /// Encerra a pergunta em andamento com um não.
    fn cancel(&self) {
        if let Some(a) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = a.answer.try_send(false);
        }
    }

    fn asking(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|a| a.label.clone())
    }
}

/// Próxima janela a perguntar ao sair: a que pediu e depois as outras, até todas estarem seladas.
fn next_to_ask(registry: &WindowRegistry, first: &str) -> Option<String> {
    let mut open: Vec<String> = registry.labels().into_iter().filter(|l| !registry.is_sealed(l)).collect();
    let at = open.iter().position(|l| l == first).unwrap_or(0);
    (!open.is_empty()).then(|| open.swap_remove(at))
}

/// Sair ou reiniciar: pergunta a cada janela pelas alterações, uma de cada vez. `true` = todas
/// concordaram (e ficam seladas); no primeiro Cancelar, nada fecha nem é descartado.
#[tauri::command]
pub async fn confirm_quit(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    quitting: State<'_, Quitting>,
) -> AppResult<bool> {
    if let Some(label) = quitting.asking() {
        raise(&app, &label);
        return Ok(false);
    }
    while let Some(label) = next_to_ask(&registry, window.label()) {
        let agreed = ask(&app, &registry, &quitting, &label).await;
        // Uma resposta sim sem selo não vale (senão a pergunta se repetiria para sempre).
        if !agreed || (registry.check(&label).is_ok() && !registry.is_sealed(&label)) {
            release_all(&app, &registry);
            return Ok(false);
        }
    }
    Ok(true)
}

async fn ask(app: &AppHandle, registry: &WindowRegistry, quitting: &Quitting, label: &str) -> bool {
    if !registry.is_ready(label) {
        // Ainda abrindo: só há o que perder se houver documentos a caminho.
        return registry.seal(label).unwrap_or(true);
    }
    let Some(mut answer) = quitting.ask(label) else {
        return false;
    };
    if app.emit_to(label, CONFIRM_CLOSE_EVENT, ()).is_err() {
        quitting.reply(label, false);
    }
    answer.recv().await.unwrap_or(false)
}

/// Desfaz o selo e devolve a janela ao normal.
fn release(app: &AppHandle, registry: &WindowRegistry, label: &str) {
    registry.unseal(label);
    let _ = app.emit_to(label, QUIT_CANCELLED_EVENT, ());
}

fn release_all(app: &AppHandle, registry: &WindowRegistry) {
    registry.labels().iter().for_each(|label| release(app, registry, label));
}

/// Resposta da janela ao `confirm-close`. O sim só vale com a janela selada; se a saída já foi
/// cancelada, a janela volta ao normal.
#[tauri::command]
pub async fn answer_close(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    quitting: State<'_, Quitting>,
    ok: bool,
) -> AppResult<()> {
    let label = window.label();
    let accepted = quitting.reply(label, ok && registry.is_sealed(label));
    if ok && !accepted {
        release(&app, &registry, label);
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
    quitting.cancel();
    release_all(&app, &registry);
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

/// Eventos das janelas (instalado uma vez no `Builder`).
pub fn on_event(window: &tauri::Window, event: &WindowEvent) {
    let (app, label) = (window.app_handle(), window.label());
    let registry = app.state::<WindowRegistry>();
    match event {
        // Fechada antes de a interface carregar, com documentos a caminho: só fecha depois de
        // recebê-los (aí a própria interface pergunta).
        WindowEvent::CloseRequested { api, .. } if !registry.is_ready(label) && registry.has_inbox(label) => {
            api.prevent_close();
        }
        WindowEvent::Destroyed if registry.check(label).is_ok() => {
            let removed = registry.remove(label);
            let store = app.state::<DocStore>();
            removed.close.into_iter().for_each(|id| drop(store.close(id)));
            for to in removed.returned_to {
                let _ = app.emit_to(to, INCOMING_EVENT, ());
            }
            app.state::<Quitting>().reply(label, true);
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
            r.seal(&label).unwrap();
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
        let mut rx = q.ask("main").unwrap();
        assert!(q.ask("doc-1").is_none(), "uma pergunta de cada vez");
        q.reply("doc-1", true);
        assert_eq!(q.asking().as_deref(), Some("main"));
        q.reply("main", false);
        assert_eq!(rx.blocking_recv(), Some(false));
        assert!(q.asking().is_none());
        assert!(q.ask("doc-1").is_some());
    }

    #[test]
    fn saida_cancelada_por_outra_janela_encerra_a_pergunta() {
        let q = Quitting::default();
        let mut rx = q.ask("main").unwrap();
        q.cancel();
        assert_eq!(rx.blocking_recv(), Some(false));
        assert!(q.asking().is_none());
        q.cancel();
        // A resposta que chega depois não vale: quem respondeu sim não pode ficar selada.
        assert!(!q.reply("main", true));
        let _rx = q.ask("main").unwrap();
        assert!(!q.reply("doc-1", true));
        assert!(q.reply("main", true));
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
