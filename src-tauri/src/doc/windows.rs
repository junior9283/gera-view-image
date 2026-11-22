//! Lote 12: janelas de documento e quem é dono de cada documento aberto.
//!
//! Cada documento pertence a uma janela só; `commands::window::guard` recusa comandos de qualquer
//! outra. Passar documentos adiante é atômico: a posse muda e a entrega (`Handoff`, com o estado
//! da interface) espera na caixa do destino até ele a retirar. Se o destino sumir antes, a entrega
//! volta para uma janela viva: um documento nunca fica órfão nem em duas janelas.
use super::model::DocId;
use crate::error::{AppError, AppResult};
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
};

pub const MAIN_WINDOW: &str = "main";
/// Prefixo das janelas novas (`doc-1`, `doc-2`...; o mesmo glob da capability). Nunca reutilizado.
const PREFIX: &str = "doc-";

/// Documentos entregues a uma janela que ainda não os retirou.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
    pub from: String,
    pub ids: Vec<DocId>,
    /// Estado da interface (desfazer, anotações, seleção...), opaco para o Rust.
    pub state: String,
}

#[derive(Default)]
struct Entry {
    label: String,
    /// Último título que a interface informou (vazio = nenhum ainda).
    title: String,
    /// A interface já ligou os ouvintes e retirou a caixa pelo menos uma vez.
    ready: bool,
    /// Fechando (tudo já perguntado): não dá nem recebe documentos.
    sealed: bool,
    inbox: Vec<Handoff>,
}

#[derive(Default)]
struct Inner {
    /// Na ordem de criação.
    windows: Vec<Entry>,
    owners: HashMap<DocId, String>,
    created: u32,
}

impl Inner {
    fn get(&mut self, label: &str) -> AppResult<&mut Entry> {
        self.windows
            .iter_mut()
            .find(|w| w.label == label)
            .ok_or_else(|| AppError::NotFound(format!("janela {label}")))
    }

    /// Documentos da janela, em ordem de abertura.
    fn owned(&self, label: &str) -> Vec<DocId> {
        let mut ids: Vec<DocId> = self.owners.iter().filter(|(_, l)| *l == label).map(|(id, _)| *id).collect();
        ids.sort();
        ids
    }

    fn give(&mut self, to: &str, handoff: Handoff) -> AppResult<()> {
        let ids = handoff.ids.clone();
        self.get(to)?.inbox.push(handoff);
        self.owners.extend(ids.into_iter().map(|id| (id, to.to_string())));
        Ok(())
    }
}

/// O que sobrou de uma janela destruída.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Removed {
    /// Documentos da janela, a fechar no `DocStore`.
    pub close: Vec<DocId>,
    /// Janelas que receberam de volta entregas não retiradas.
    pub returned_to: Vec<String>,
}

/// Registro compartilhado (estado do Tauri).
pub struct WindowRegistry(Mutex<Inner>);

impl Default for WindowRegistry {
    fn default() -> Self {
        let main = Entry { label: MAIN_WINDOW.into(), ..Default::default() };
        WindowRegistry(Mutex::new(Inner { windows: vec![main], ..Default::default() }))
    }
}

impl WindowRegistry {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registra uma janela nova e devolve o rótulo dela.
    pub fn create(&self) -> String {
        let mut s = self.lock();
        s.created += 1;
        let label = format!("{PREFIX}{}", s.created);
        s.windows.push(Entry { label: label.clone(), ..Default::default() });
        label
    }

    /// Rótulos das janelas de documento vivas, na ordem de criação.
    pub fn labels(&self) -> Vec<String> {
        self.lock().windows.iter().map(|w| w.label.clone()).collect()
    }

    /// Rótulo e título de cada janela, na ordem de criação.
    pub fn titles(&self) -> Vec<(String, String)> {
        self.lock().windows.iter().map(|w| (w.label.clone(), w.title.clone())).collect()
    }

    pub fn set_title(&self, label: &str, title: String) -> AppResult<()> {
        self.lock().get(label)?.title = title;
        Ok(())
    }

    /// Só rótulos de janelas de documento vivas.
    pub fn check(&self, label: &str) -> AppResult<()> {
        self.lock().get(label).map(|_| ())
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.lock().get(label).is_ok_and(|w| w.ready)
    }

    pub fn has_inbox(&self, label: &str) -> bool {
        self.lock().get(label).is_ok_and(|w| !w.inbox.is_empty())
    }

    pub fn owns(&self, label: &str, id: DocId) -> bool {
        self.lock().owners.get(&id).is_some_and(|l| l == label)
    }

    pub fn owner(&self, id: DocId) -> Option<String> {
        self.lock().owners.get(&id).cloned()
    }

    /// Documentos da janela, em ordem de abertura.
    pub fn owned(&self, label: &str) -> Vec<DocId> {
        self.lock().owned(label)
    }

    /// Documentos recém-criados passam a ser da janela que os pediu.
    pub fn claim(&self, label: &str, ids: &[DocId]) -> AppResult<()> {
        let mut s = self.lock();
        s.get(label)?;
        for id in ids {
            s.owners.entry(*id).or_insert_with(|| label.to_string());
        }
        Ok(())
    }

    /// A janela pode usar o documento? Um sem dono (criado por um comando que não chamou `claim`)
    /// passa a ser da primeira que o usar.
    pub fn access(&self, label: &str, id: DocId) -> AppResult<()> {
        let mut s = self.lock();
        s.get(label)?;
        if s.owners.entry(id).or_insert_with(|| label.to_string()) == label {
            return Ok(());
        }
        Err(AppError::Unsupported(format!("documento {} é de outra janela", id.0)))
    }

    /// Documento fechado.
    pub fn forget(&self, id: DocId) {
        self.lock().owners.remove(&id);
    }

    /// Passa os documentos de `from` para `to`: todos ou nenhum.
    pub fn transfer(&self, from: &str, to: &str, ids: Vec<DocId>, state: String) -> AppResult<()> {
        let mut s = self.lock();
        let refused = |why: &str| Err(AppError::Unsupported(format!("mover documentos: {why}")));
        if ids.is_empty() || from == to {
            return refused("nada a mover");
        }
        if s.get(from)?.sealed || s.get(to)?.sealed {
            return refused("janela fechando");
        }
        if ids.iter().any(|id| s.owners.get(id).is_none_or(|l| l != from)) {
            return refused("documento de outra janela");
        }
        // Entregue e ainda não retirado: o estado dele ainda não passou por `from`.
        if s.get(from)?.inbox.iter().any(|h| h.ids.iter().any(|id| ids.contains(id))) {
            return refused("documento ainda chegando");
        }
        s.give(to, Handoff { from: from.to_string(), ids, state })
    }

    /// Retira as entregas da janela, que passa a contar como pronta.
    pub fn take(&self, label: &str) -> AppResult<Vec<Handoff>> {
        let mut s = self.lock();
        let w = s.get(label)?;
        w.ready = true;
        Ok(std::mem::take(&mut w.inbox))
    }

    /// Começa a fechar a janela. `false` = há documentos chegando (retire-os e pergunte de novo).
    pub fn seal(&self, label: &str) -> AppResult<bool> {
        let mut s = self.lock();
        let w = s.get(label)?;
        w.sealed = w.inbox.is_empty();
        Ok(w.sealed)
    }

    pub fn unseal(&self, label: &str) {
        if let Ok(w) = self.lock().get(label) {
            w.sealed = false;
        }
    }

    pub fn is_sealed(&self, label: &str) -> bool {
        self.lock().get(label).is_ok_and(|w| w.sealed)
    }

    /// Janela destruída. As entregas não retiradas voltam para quem as mandou (ou para outra janela
    /// viva que não esteja fechando); o resto dos documentos dela é fechado.
    pub fn remove(&self, label: &str) -> Removed {
        let mut s = self.lock();
        let Some(at) = s.windows.iter().position(|w| w.label == label) else {
            return Removed::default();
        };
        let gone = s.windows.remove(at);
        let mut out = Removed::default();
        for h in gone.inbox {
            let open = || s.windows.iter().filter(|w| !w.sealed);
            let to = open().find(|w| w.label == h.from).or_else(|| open().next());
            if let Some(to) = to.map(|w| w.label.clone())
                && s.give(&to, h).is_ok()
            {
                out.returned_to.push(to);
            }
        }
        out.close = s.owned(label);
        s.owners.retain(|_, l| l != label);
        out
    }

    /// Desfaz `create` + `transfer` quando a janela não pôde ser criada: a origem ainda tem tudo.
    pub fn undo_create(&self, label: &str, from: &str) {
        let mut s = self.lock();
        s.windows.retain(|w| w.label != label);
        for owner in s.owners.values_mut().filter(|l| *l == label) {
            *owner = from.to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: DocId = DocId(1);
    const B: DocId = DocId(2);

    /// Principal com os documentos 1 e 2, e uma segunda janela pronta.
    fn two() -> (WindowRegistry, String) {
        let r = WindowRegistry::default();
        r.claim(MAIN_WINDOW, &[A, B]).unwrap();
        let w = r.create();
        r.take(MAIN_WINDOW).unwrap();
        r.take(&w).unwrap();
        (r, w)
    }

    #[test]
    fn rotulos_novos_nunca_se_repetem() {
        let r = WindowRegistry::default();
        let first = r.create();
        r.remove(&first);
        assert_eq!(first, "doc-1");
        assert_eq!(r.create(), "doc-2");
        assert_eq!(r.labels(), ["main", "doc-2"]);
    }

    #[test]
    fn so_o_dono_usa_o_documento() {
        let (r, w) = two();
        assert!(r.access(MAIN_WINDOW, A).is_ok());
        assert!(r.access(&w, A).is_err());
        assert!(r.access("print", A).is_err(), "janela que não é de documento");
        assert!(r.access("doc-99", A).is_err(), "rótulo inventado");
    }

    #[test]
    fn documento_sem_dono_e_da_primeira_que_o_usa() {
        let (r, w) = two();
        assert!(r.access(&w, DocId(9)).is_ok());
        assert!(r.access(MAIN_WINDOW, DocId(9)).is_err());
    }

    #[test]
    fn claim_nao_toma_documento_de_outra_janela() {
        let (r, w) = two();
        r.claim(&w, &[A]).unwrap();
        assert_eq!(r.owner(A).as_deref(), Some(MAIN_WINDOW));
        assert!(r.claim("doc-99", &[DocId(5)]).is_err());
        assert_eq!(r.owner(DocId(5)), None);
    }

    #[test]
    fn mover_troca_a_posse_e_entrega_o_estado_uma_vez() {
        let (r, w) = two();
        r.transfer(MAIN_WINDOW, &w, vec![B], "estado".into()).unwrap();
        assert!(r.access(MAIN_WINDOW, B).is_err(), "a origem perde na hora");
        assert!(r.access(&w, B).is_ok());
        let got = r.take(&w).unwrap();
        assert_eq!(got, [Handoff { from: "main".into(), ids: vec![B], state: "estado".into() }]);
        assert!(r.take(&w).unwrap().is_empty());
        assert_eq!((r.owned(MAIN_WINDOW), r.owned(&w)), (vec![A], vec![B]));
    }

    #[test]
    fn mover_e_tudo_ou_nada() {
        let (r, w) = two();
        r.claim(&w, &[DocId(3)]).unwrap();
        assert!(r.transfer(MAIN_WINDOW, &w, vec![A, DocId(3)], String::new()).is_err());
        assert!(r.transfer(MAIN_WINDOW, "doc-99", vec![A], String::new()).is_err());
        assert!(r.transfer(MAIN_WINDOW, MAIN_WINDOW, vec![A], String::new()).is_err());
        assert!(r.transfer(MAIN_WINDOW, &w, vec![], String::new()).is_err());
        assert_eq!(r.owner(A).as_deref(), Some(MAIN_WINDOW));
        assert!(!r.has_inbox(&w));
    }

    #[test]
    fn documento_ainda_chegando_nao_segue_adiante() {
        let (r, w) = two();
        let third = r.create();
        r.transfer(MAIN_WINDOW, &w, vec![A], "estado".into()).unwrap();
        assert!(r.transfer(&w, &third, vec![A], "vazio".into()).is_err());
        assert_eq!(r.take(&w).unwrap()[0].state, "estado");
    }

    #[test]
    fn janela_fechando_nao_da_nem_recebe() {
        let (r, w) = two();
        assert!(r.seal(&w).unwrap());
        assert!(r.transfer(MAIN_WINDOW, &w, vec![A], String::new()).is_err());
        r.unseal(&w);
        assert!(r.transfer(MAIN_WINDOW, &w, vec![A], String::new()).is_ok());
        // Com entrega na caixa, não fecha sem perguntar de novo.
        assert!(!r.seal(&w).unwrap());
        assert!(!r.is_sealed(&w));
        r.seal(MAIN_WINDOW).unwrap();
        assert!(r.transfer(MAIN_WINDOW, &w, vec![B], String::new()).is_err());
    }

    #[test]
    fn janela_destruida_fecha_os_dela_e_devolve_os_que_estavam_chegando() {
        let (r, w) = two();
        r.claim(&w, &[DocId(7)]).unwrap();
        r.transfer(MAIN_WINDOW, &w, vec![B], "estado".into()).unwrap();
        let out = r.remove(&w);
        assert_eq!(out, Removed { close: vec![DocId(7)], returned_to: vec!["main".into()] });
        assert_eq!(r.owner(DocId(7)), None, "a posse não sobra para uma janela que não existe");
        assert_eq!(r.owned(MAIN_WINDOW), [A, B]);
        assert_eq!(r.take(MAIN_WINDOW).unwrap()[0].state, "estado");
        assert!(r.remove(&w).close.is_empty(), "destruir de novo não faz nada");
    }

    #[test]
    fn devolucao_vai_para_outra_janela_se_a_origem_ja_fechou() {
        let (r, w) = two();
        let third = r.create();
        r.transfer(MAIN_WINDOW, &w, vec![A, B], "estado".into()).unwrap();
        r.remove(MAIN_WINDOW);
        assert_eq!(r.remove(&w).returned_to, std::slice::from_ref(&third));
        assert_eq!(r.owned(&third), [A, B]);
    }

    #[test]
    fn devolucao_nao_vai_para_janela_fechando() {
        let (r, w) = two();
        let third = r.create();
        r.transfer(MAIN_WINDOW, &w, vec![A], "estado".into()).unwrap();
        r.seal(MAIN_WINDOW).unwrap();
        assert_eq!(r.remove(&w).returned_to, [third]);
    }

    #[test]
    fn janela_que_nao_abriu_devolve_tudo_a_origem_sem_entrega() {
        let r = WindowRegistry::default();
        r.claim(MAIN_WINDOW, &[A, B]).unwrap();
        let w = r.create();
        r.transfer(MAIN_WINDOW, &w, vec![A], "estado".into()).unwrap();
        r.undo_create(&w, MAIN_WINDOW);
        assert_eq!(r.labels(), ["main"]);
        assert_eq!(r.owned(MAIN_WINDOW), [A, B]);
        assert!(r.take(MAIN_WINDOW).unwrap().is_empty(), "a origem nunca largou o estado");
    }

    #[test]
    fn documento_fechado_sai_do_registro() {
        let (r, w) = two();
        r.forget(A);
        assert_eq!(r.owner(A), None);
        assert!(r.owned(&w).is_empty());
    }
}
