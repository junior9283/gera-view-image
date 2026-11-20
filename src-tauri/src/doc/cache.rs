//! Cache LRU, limitado por bytes, das imagens intermediárias (resultado das operações).
use super::model::DocId;
use ::image::RgbaImage;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

/// `(documento, ops.len(), quadro)`: o resultado de aplicar as `n` primeiras operações.
pub type CacheKey = (DocId, usize, u32);

/// Limite padrão: 1 GiB.
pub const DEFAULT_LIMIT: usize = 1 << 30;

struct Entry {
    img: Arc<RgbaImage>,
    bytes: usize,
    used: u64,
}

#[derive(Default)]
struct State {
    map: HashMap<CacheKey, Entry>,
    tick: u64,
    total: usize,
    peak: usize,
}

pub struct RenderCache {
    limit: usize,
    state: Mutex<State>,
}

impl Default for RenderCache {
    fn default() -> Self {
        Self::new(DEFAULT_LIMIT)
    }
}

impl RenderCache {
    pub fn new(limit: usize) -> Self {
        RenderCache {
            limit,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn get(&self, key: &CacheKey) -> Option<Arc<RgbaImage>> {
        let mut st = self.lock();
        st.tick += 1;
        let tick = st.tick;
        st.map.get_mut(key).map(|e| {
            e.used = tick;
            e.img.clone()
        })
    }

    /// Insere removendo os menos usados até caber. Imagem maior que o limite não entra.
    pub fn insert(&self, key: CacheKey, img: Arc<RgbaImage>) {
        let bytes = img.as_raw().len();
        if bytes > self.limit {
            return;
        }
        let mut st = self.lock();
        if let Some(old) = st.map.remove(&key) {
            st.total -= old.bytes;
        }
        while st.total + bytes > self.limit {
            let Some(&lru) = st.map.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k) else {
                break;
            };
            let e = st.map.remove(&lru).expect("chave existente");
            st.total -= e.bytes;
        }
        st.tick += 1;
        let used = st.tick;
        st.map.insert(key, Entry { img, bytes, used });
        st.total += bytes;
        st.peak = st.peak.max(st.total);
    }

    fn retain(&self, keep: impl Fn(&CacheKey) -> bool) {
        let mut st = self.lock();
        let mut freed = 0;
        st.map.retain(|k, e| {
            let kept = keep(k);
            if !kept {
                freed += e.bytes;
            }
            kept
        });
        st.total -= freed;
    }

    pub fn remove_doc(&self, id: DocId) {
        self.retain(|k| k.0 != id);
    }

    /// Remove os resultados com mais de `len` operações (ramo de refazer descartado).
    pub fn invalidate_above(&self, id: DocId, len: usize) {
        self.retain(|k| k.0 != id || k.1 <= len);
    }

    pub fn total_bytes(&self) -> usize {
        self.lock().total
    }

    /// Maior total já ocupado desde a criação.
    pub fn peak_bytes(&self) -> usize {
        self.lock().peak
    }
}
