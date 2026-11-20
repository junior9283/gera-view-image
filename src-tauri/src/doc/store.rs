//! Documentos abertos: original decodificado + lista de operações (não destrutivo).
//!
//! JPEGs grandes abrem com uma prévia reduzida (escala DCT) e a decodificação completa
//! roda em segundo plano; quando termina, `rev` muda e o ouvinte (`set_listener`) recebe
//! o `DocInfo` novo. Quem precisa da resolução cheia (`apply_op`, `render_full`) espera.
use super::{
    cache::RenderCache,
    model::{DocId, DocInfo, Op, Rect, SourceFormat},
};
use crate::{
    error::{AppError, AppResult},
    image::{
        decode::{self, Decoded},
        ops, thumb,
    },
};
use ::image::RgbaImage;
use rayon::prelude::*;
use std::{
    collections::HashMap,
    ops::Deref,
    path::Path,
    sync::{
        Arc, Condvar, Mutex, MutexGuard, RwLock,
        atomic::{AtomicU32, Ordering},
    },
};

/// JPEG acima disto (em pixels) abre com prévia reduzida e completa em segundo plano.
pub const PREVIEW_MIN_PIXELS: u64 = 4_000_000;
/// A prévia tem pelo menos este lado maior (cobre uma tela 2K sem ampliar).
pub const PREVIEW_LONG_SIDE: u32 = 2048;

pub struct Document {
    pub info: DocInfo,
    /// Original em resolução cheia. Enquanto `loading`, guarda só a prévia reduzida.
    pub source: Arc<Decoded>,
    pub loading: bool,
    /// Dimensões do original (já orientado), mesmo durante a prévia.
    pub full_size: (u32, u32),
    pub ops: Vec<Op>,
    pub redo: Vec<Op>,
    /// `ops.len()` no último salvar (`usize::MAX` se esse estado ficou inalcançável).
    pub saved_len: usize,
    error: Option<AppError>,
    /// Muda quando resultados em cache deixam de valer (refazer descartado, original trocado).
    generation: u64,
}

impl Document {
    fn new(id: DocId, path: &str, source: Decoded, full_size: (u32, u32), loading: bool) -> Self {
        let p = Path::new(path);
        let read_only = std::fs::metadata(p)
            .map(|m| m.permissions().readonly())
            .unwrap_or(false);
        let writable = source.format.writable()
            && !(source.format == SourceFormat::Gif && source.frames.len() > 1)
            && !read_only;
        let info = DocInfo {
            id,
            path: path.to_string(),
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string()),
            format: source.format,
            width: full_size.0,
            height: full_size.1,
            frames: source.frames.len() as u32,
            writable,
            dirty: false,
            can_undo: false,
            can_redo: false,
            rev: 0,
            error: None,
        };
        Document {
            info,
            source: Arc::new(source),
            loading,
            full_size,
            ops: vec![],
            redo: vec![],
            saved_len: 0,
            error: None,
            generation: 0,
        }
    }

    fn failed(id: DocId, path: &str, err: AppError) -> Self {
        let format = decode::format_from_path(Path::new(path)).unwrap_or(SourceFormat::Png);
        let empty = Decoded {
            frames: vec![],
            delays_ms: vec![],
            format,
            icc: None,
            exif: None,
            dpi: None,
        };
        let mut d = Document::new(id, path, empty, (0, 0), false);
        d.info.writable = false;
        d.info.error = Some(err.code().to_string());
        d.error = Some(err);
        d
    }

    pub fn error(&self) -> Option<&AppError> {
        self.error.as_ref()
    }

    fn check(&self) -> AppResult<()> {
        self.error.clone().map_or(Ok(()), Err)
    }

    /// Dimensões depois de todas as operações.
    pub fn size_after_ops(&self) -> (u32, u32) {
        self.ops.iter().fold(self.full_size, ops::output_size)
    }

    /// Recalcula os campos derivados do `DocInfo` e avança `rev`.
    fn refresh(&mut self) {
        let (w, h) = self.size_after_ops();
        let i = &mut self.info;
        i.width = w;
        i.height = h;
        i.frames = self.source.frames.len() as u32;
        i.dirty = self.ops.len() != self.saved_len;
        i.can_undo = !self.ops.is_empty();
        i.can_redo = !self.redo.is_empty();
        i.error = self.error.as_ref().map(|e| e.code().to_string());
        i.rev += 1;
    }
}

/// Pixels de um quadro: o próprio original (sem cópia) ou um resultado de operações.
pub enum Pixels {
    Source(Arc<Decoded>, usize),
    Owned(Arc<RgbaImage>),
}

impl Deref for Pixels {
    type Target = RgbaImage;
    fn deref(&self) -> &RgbaImage {
        match self {
            Pixels::Source(d, f) => &d.frames[*f],
            Pixels::Owned(img) => img,
        }
    }
}

pub type Listener = Box<dyn Fn(&DocInfo) + Send + Sync>;

struct Inner {
    docs: Mutex<HashMap<DocId, Document>>,
    /// Sinalizado quando um documento termina de carregar ou é fechado.
    ready: Condvar,
    cache: RenderCache,
    next_id: AtomicU32,
    listener: RwLock<Option<Listener>>,
}

/// Documentos abertos (`Mutex<HashMap<DocId, Document>>`), compartilhável entre threads.
#[derive(Clone)]
pub struct DocStore {
    inner: Arc<Inner>,
}

impl Default for DocStore {
    fn default() -> Self {
        Self::new()
    }
}

enum Opened {
    Ready(Decoded),
    Preview {
        preview: Decoded,
        full_size: (u32, u32),
        bytes: Vec<u8>,
    },
}

fn open_file(path: &Path) -> AppResult<Opened> {
    let bytes = std::fs::read(path)?;
    if decode::detect_format(path, &bytes) == Some(SourceFormat::Jpeg)
        && decode::jpeg_size(&bytes).is_some_and(|(w, h)| w as u64 * h as u64 > PREVIEW_MIN_PIXELS)
    {
        // Se o decodificador rápido não der conta (ex.: JPEG aritmético), cai no completo.
        if let Ok(p) = decode::decode_jpeg_preview(&bytes, PREVIEW_LONG_SIDE) {
            let preview = Decoded {
                icc: p.icc,
                exif: p.exif,
                ..Decoded::single(p.image, SourceFormat::Jpeg)
            };
            return Ok(Opened::Preview {
                preview,
                full_size: p.full_size,
                bytes,
            });
        }
    }
    decode::decode_bytes(path, &bytes).map(Opened::Ready)
}

impl DocStore {
    pub fn new() -> Self {
        Self::with_cache(RenderCache::default())
    }

    pub fn with_cache(cache: RenderCache) -> Self {
        DocStore {
            inner: Arc::new(Inner {
                docs: Mutex::new(HashMap::new()),
                ready: Condvar::new(),
                cache,
                next_id: AtomicU32::new(1),
                listener: RwLock::new(None),
            }),
        }
    }

    /// Chamado (fora de qualquer trava) quando um documento muda sozinho.
    pub fn set_listener(&self, f: impl Fn(&DocInfo) + Send + Sync + 'static) {
        *self
            .inner
            .listener
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(Box::new(f));
    }

    pub fn cache(&self) -> &RenderCache {
        &self.inner.cache
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<DocId, Document>> {
        self.inner.docs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Trava esperando o documento sair do estado de prévia.
    fn lock_loaded(&self, id: DocId) -> MutexGuard<'_, HashMap<DocId, Document>> {
        self.inner
            .ready
            .wait_while(self.lock(), |m| m.get(&id).is_some_and(|d| d.loading))
            .unwrap_or_else(|e| e.into_inner())
    }

    fn next_id(&self) -> DocId {
        DocId(self.inner.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Abre os arquivos em paralelo. Cada um vira um `DocInfo`; os que falham vêm com `error`.
    pub fn open_documents(&self, paths: &[String]) -> Vec<DocInfo> {
        let ids: Vec<DocId> = paths.iter().map(|_| self.next_id()).collect();
        let opened: Vec<(Document, Option<Vec<u8>>)> = paths
            .par_iter()
            .zip(ids)
            .map(|(path, id)| match open_file(Path::new(path)) {
                Ok(Opened::Ready(d)) => {
                    let size = d.frames.first().map_or((0, 0), RgbaImage::dimensions);
                    (Document::new(id, path, d, size, false), None)
                }
                Ok(Opened::Preview {
                    preview,
                    full_size,
                    bytes,
                }) => (
                    Document::new(id, path, preview, full_size, true),
                    Some(bytes),
                ),
                Err(e) => (Document::failed(id, path, e), None),
            })
            .collect();
        let mut infos = Vec::with_capacity(opened.len());
        let mut pending = Vec::new();
        {
            let mut map = self.lock();
            for (doc, bytes) in opened {
                infos.push(doc.info.clone());
                if let Some(b) = bytes {
                    pending.push((doc.info.id, doc.info.path.clone(), b));
                }
                map.insert(doc.info.id, doc);
            }
        }
        for (id, path, bytes) in pending {
            let store = self.clone();
            rayon::spawn(move || {
                let full = decode::decode_bytes(Path::new(&path), &bytes);
                drop(bytes);
                store.finish_loading(id, full);
            });
        }
        infos
    }

    fn finish_loading(&self, id: DocId, full: AppResult<Decoded>) {
        let info = {
            let mut map = self.lock();
            let Some(doc) = map.get_mut(&id) else { return };
            match full {
                Ok(d) => doc.source = Arc::new(d),
                Err(e) => doc.error = Some(e),
            }
            doc.loading = false;
            doc.generation += 1;
            doc.refresh();
            doc.info.clone()
        };
        self.inner.ready.notify_all();
        self.inner.cache.remove_doc(id);
        if let Some(f) = self
            .inner
            .listener
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            f(&info);
        }
    }

    /// Acrescenta um documento já decodificado (área de transferência, captura, testes).
    pub fn insert_decoded(&self, path: &str, decoded: Decoded) -> DocInfo {
        let id = self.next_id();
        let size = decoded.frames.first().map_or((0, 0), RgbaImage::dimensions);
        let doc = Document::new(id, path, decoded, size, false);
        let info = doc.info.clone();
        self.lock().insert(id, doc);
        info
    }

    pub fn close(&self, id: DocId) -> AppResult<()> {
        let removed = self.lock().remove(&id);
        self.inner.ready.notify_all();
        self.inner.cache.remove_doc(id);
        removed.map(|_| ()).ok_or_else(|| not_found(id))
    }

    pub fn info(&self, id: DocId) -> AppResult<DocInfo> {
        self.with_doc(id, |d| d.info.clone())
    }

    /// Espera a decodificação completa (retorna na hora se já terminou).
    pub fn wait_ready(&self, id: DocId) -> AppResult<()> {
        let map = self.lock_loaded(id);
        map.get(&id).ok_or_else(|| not_found(id))?.check()
    }

    pub fn with_doc<R>(&self, id: DocId, f: impl FnOnce(&Document) -> R) -> AppResult<R> {
        self.lock().get(&id).map(f).ok_or_else(|| not_found(id))
    }

    /// Altera o documento (já carregado por inteiro) e recalcula o `DocInfo` (ex.: salvar).
    pub fn with_doc_mut<R>(
        &self,
        id: DocId,
        f: impl FnOnce(&mut Document) -> R,
    ) -> AppResult<(R, DocInfo)> {
        let mut map = self.lock_loaded(id);
        let doc = map.get_mut(&id).ok_or_else(|| not_found(id))?;
        let r = f(doc);
        doc.refresh();
        Ok((r, doc.info.clone()))
    }

    pub fn source_bytes(&self, id: DocId) -> AppResult<usize> {
        self.with_doc(id, |d| d.source.bytes())
    }

    pub fn apply_op(&self, id: DocId, op: Op) -> AppResult<DocInfo> {
        let mut map = self.lock_loaded(id);
        let doc = map.get_mut(&id).ok_or_else(|| not_found(id))?;
        doc.check()?;
        ops::validate(doc.size_after_ops(), &op).map_err(AppError::Unsupported)?;
        let n = doc.ops.len();
        if !doc.redo.is_empty() {
            doc.redo.clear();
            doc.generation += 1;
            self.inner.cache.invalidate_above(id, n);
        }
        if doc.saved_len > n {
            doc.saved_len = usize::MAX;
        }
        doc.ops.push(op);
        doc.refresh();
        Ok(doc.info.clone())
    }

    /// Desfaz a última operação (sem operações, só devolve o `DocInfo`).
    pub fn undo(&self, id: DocId) -> AppResult<DocInfo> {
        self.move_op(id, true)
    }

    pub fn redo(&self, id: DocId) -> AppResult<DocInfo> {
        self.move_op(id, false)
    }

    fn move_op(&self, id: DocId, undo: bool) -> AppResult<DocInfo> {
        let mut map = self.lock_loaded(id);
        let doc = map.get_mut(&id).ok_or_else(|| not_found(id))?;
        doc.check()?;
        let (from, to) = if undo {
            (&mut doc.ops, &mut doc.redo)
        } else {
            (&mut doc.redo, &mut doc.ops)
        };
        if let Some(op) = from.pop() {
            to.push(op);
            doc.refresh();
        }
        Ok(doc.info.clone())
    }

    /// Quadro em resolução cheia com todas as operações (espera a decodificação completa).
    pub fn render_full(&self, id: DocId, frame: u32) -> AppResult<Pixels> {
        self.pixels(id, frame, false).map(|(p, _, _)| p)
    }

    /// Pixels atuais, dimensões lógicas (resolução cheia) e a escala lógica→pixels
    /// (< 1 só durante a prévia).
    fn pixels(
        &self,
        id: DocId,
        frame: u32,
        allow_preview: bool,
    ) -> AppResult<(Pixels, (u32, u32), f64)> {
        let map = if allow_preview {
            self.lock()
        } else {
            self.lock_loaded(id)
        };
        let doc = map.get(&id).ok_or_else(|| not_found(id))?;
        doc.check()?;
        let f = frame as usize;
        if f >= doc.source.frames.len() {
            return Err(AppError::NotFound(format!("quadro {frame} inexistente")));
        }
        if doc.loading {
            let scale = doc.source.frames[0].width() as f64 / doc.full_size.0.max(1) as f64;
            return Ok((Pixels::Source(doc.source.clone(), 0), doc.full_size, scale));
        }
        let n = doc.ops.len();
        let size = doc.size_after_ops();
        if n == 0 {
            return Ok((Pixels::Source(doc.source.clone(), f), size, 1.0));
        }
        let cache = &self.inner.cache;
        let (mut k, mut base) = (n, None);
        while k > 0 {
            if let Some(img) = cache.get(&(id, k, frame)) {
                base = Some(img);
                break;
            }
            k -= 1;
        }
        if k == n {
            return Ok((Pixels::Owned(base.expect("encontrado no cache")), size, 1.0));
        }
        let tail = doc.ops[k..n].to_vec();
        let generation = doc.generation;
        let source = doc.source.clone();
        drop(map);

        let mut cur: Option<RgbaImage> = None;
        for op in &tail {
            let input = cur
                .as_ref()
                .or(base.as_deref())
                .unwrap_or(&source.frames[f]);
            cur = Some(ops::apply(input, op));
        }
        let out = Arc::new(cur.expect("ao menos uma operação"));
        let map = self.lock();
        if map
            .get(&id)
            .is_some_and(|d| d.generation == generation && d.ops.len() >= n)
        {
            cache.insert((id, n, frame), out.clone());
        }
        Ok((Pixels::Owned(out), size, 1.0))
    }

    /// Buffer do IPC (`u32 LE w`, `u32 LE h`, RGBA) que cabe em `max_w`x`max_h` sem ampliar.
    /// `region` está em coordenadas da imagem atual (depois das operações).
    pub fn render_view(
        &self,
        id: DocId,
        frame: u32,
        max_w: u32,
        max_h: u32,
        region: Option<Rect>,
    ) -> AppResult<Vec<u8>> {
        let (px, (w, h), scale) = self.pixels(id, frame, true)?;
        let region = region.map_or(Rect { x: 0, y: 0, w, h }, |r| ops::clamp_rect(r, w, h));
        let (out_w, out_h) = thumb::fit_size(region.w, region.h, max_w, max_h);
        let src = if scale == 1.0 {
            region
        } else {
            let s = |v: u32| (v as f64 * scale).round() as u32;
            let r = Rect {
                x: s(region.x),
                y: s(region.y),
                w: s(region.w).max(1),
                h: s(region.h).max(1),
            };
            ops::clamp_rect(r, px.width(), px.height())
        };
        Ok(thumb::view_buffer(&px, src, out_w, out_h))
    }

    pub fn thumbnail(&self, id: DocId, frame: u32, size: u32) -> AppResult<Vec<u8>> {
        self.render_view(id, frame, size, size, None)
    }
}

fn not_found(id: DocId) -> AppError {
    AppError::NotFound(format!("documento {} não está aberto", id.0))
}
