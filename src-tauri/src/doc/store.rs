//! Documentos abertos: original decodificado + lista de operações (não destrutivo).
//!
//! JPEGs grandes abrem com uma prévia reduzida (escala DCT) e a decodificação completa
//! roda em segundo plano; quando termina, `rev` muda e o ouvinte (`set_listener`) recebe
//! o `DocInfo` novo. Quem precisa da resolução cheia (`apply_op`, `render_full`) espera.
//! RAW faz o mesmo com a prévia JPEG embutida.
//!
//! Memória: decodificações cheias simultâneas reservam um orçamento de bytes
//! (`DecodeBudget`), e renders iguais em andamento são calculados uma vez só.
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
        Arc, Condvar, Mutex, MutexGuard, OnceLock, RwLock,
        atomic::{AtomicU32, AtomicUsize, Ordering},
    },
};

/// Orçamento padrão para decodificações cheias simultâneas (estimativa em bytes RGBA8).
pub const DEFAULT_DECODE_BUDGET: usize = 3 << 30;

/// Semáforo por bytes: uma decodificação espera enquanto as em andamento somadas a ela
/// passariam do limite. Sozinha, qualquer uma passa (o teto por imagem é `MAX_DECODE_BYTES`).
struct DecodeBudget {
    used: Mutex<usize>,
    freed: Condvar,
    limit: usize,
    peak: AtomicUsize,
}

struct Reservation<'a>(&'a DecodeBudget, usize);

impl DecodeBudget {
    fn new(limit: usize) -> Self {
        DecodeBudget {
            used: Mutex::new(0),
            freed: Condvar::new(),
            limit,
            peak: AtomicUsize::new(0),
        }
    }

    fn reserve(&self, bytes: usize) -> Reservation<'_> {
        let mut used = self
            .freed
            .wait_while(self.used.lock().unwrap_or_else(|e| e.into_inner()), |u| {
                *u > 0 && u.saturating_add(bytes) > self.limit
            })
            .unwrap_or_else(|e| e.into_inner());
        *used = used.saturating_add(bytes);
        self.peak.fetch_max(*used, Ordering::Relaxed);
        Reservation(self, bytes)
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut used = self.0.used.lock().unwrap_or_else(|e| e.into_inner());
        *used = used.saturating_sub(self.1);
        drop(used);
        self.0.freed.notify_all();
    }
}

/// Render em andamento de `(doc, ops.len(), quadro, generation)`.
type InflightKey = (DocId, usize, u32, u64);
type Inflight = Arc<OnceLock<Arc<RgbaImage>>>;

/// Estado do documento que um render reflete: `(ops.len(), generation)`.
type RenderState = (usize, u64);
/// Base da prévia de ajuste: `(doc, estado, max_w, max_h)`.
type PreviewKey = (DocId, RenderState, u32, u32);

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
    pub(super) error: Option<AppError>,
    /// Muda quando resultados em cache deixam de valer (refazer descartado, original trocado).
    pub(super) generation: u64,
    /// Tamanho e mtime do arquivo como o app o conhece (abertura ou último salvar).
    pub(super) disk: Option<DiskStamp>,
    /// Carimbo da abertura: o disco ainda tem o original?
    pub(super) opened_disk: Option<DiskStamp>,
    /// Decodificação da abertura, guardada quando "Reverter para o Último Salvo" troca `source`.
    pub(super) original: Option<Arc<Decoded>>,
}

/// Identidade do arquivo em disco para detectar alteração externa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskStamp {
    pub len: u64,
    pub mtime: std::time::SystemTime,
}

impl DiskStamp {
    pub fn of(path: &Path) -> Option<Self> {
        let m = std::fs::metadata(path).ok()?;
        Some(DiskStamp {
            len: m.len(),
            mtime: m.modified().ok()?,
        })
    }
}

impl Document {
    pub(super) fn new(
        id: DocId,
        path: &str,
        source: impl Into<Arc<Decoded>>,
        full_size: (u32, u32),
        loading: bool,
    ) -> Self {
        let source = source.into();
        let p = Path::new(path);
        let disk = DiskStamp::of(p);
        let writable = Self::can_save(path, source.format, source.frames.len());
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
            source,
            loading,
            full_size,
            ops: vec![],
            redo: vec![],
            saved_len: 0,
            error: None,
            generation: 0,
            disk,
            opened_disk: disk,
            original: None,
        }
    }

    /// Salvar grava no próprio arquivo: há caminho, o formato é gravável, uma só página/quadro
    /// (TIFF de várias páginas e GIF animado perderiam conteúdo) e o arquivo não é só leitura.
    pub(super) fn can_save(path: &str, format: SourceFormat, frames: usize) -> bool {
        let read_only = std::fs::metadata(path)
            .map(|m| m.permissions().readonly())
            .unwrap_or(false);
        !path.is_empty() && format.writable() && frames <= 1 && !read_only
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
    pub(super) fn refresh(&mut self) {
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
    budget: DecodeBudget,
    inflight: Mutex<HashMap<InflightKey, Inflight>>,
    pipeline_runs: AtomicUsize,
    /// Cache de 1 entrada da base reduzida da prévia de ajuste (`preview_base`).
    preview: Mutex<Option<(PreviewKey, Arc<Vec<u8>>)>>,
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
        /// `None` quando só a revelação completa sabe (RAW).
        full_size: Option<(u32, u32)>,
        /// Reserva (`estimate_bytes`) da decodificação completa, que relê o arquivo.
        estimate: usize,
    },
}

fn open_file(path: &Path, budget: &DecodeBudget) -> AppResult<Opened> {
    let bytes = std::fs::read(path)?;
    let format = decode::detect_format(path, &bytes);
    let estimate = || decode::estimate_bytes(path, &bytes);
    if format == Some(SourceFormat::Raw)
        && let Some(img) = decode::raw_preview(&bytes)
    {
        return Ok(Opened::Preview {
            preview: Decoded::single(img, SourceFormat::Raw),
            full_size: None,
            estimate: estimate(),
        });
    }
    if format == Some(SourceFormat::Jpeg)
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
                full_size: Some(p.full_size),
                estimate: estimate(),
            });
        }
    }
    let _r = budget.reserve(estimate());
    decode::decode_bytes(path, &bytes).map(Opened::Ready)
}

impl DocStore {
    pub fn new() -> Self {
        Self::with_cache(RenderCache::default())
    }

    pub fn with_cache(cache: RenderCache) -> Self {
        Self::with_limits(cache, DEFAULT_DECODE_BUDGET)
    }

    /// `decode_budget`: bytes (estimados) de decodificações cheias ao mesmo tempo.
    pub fn with_limits(cache: RenderCache, decode_budget: usize) -> Self {
        DocStore {
            inner: Arc::new(Inner {
                docs: Mutex::new(HashMap::new()),
                ready: Condvar::new(),
                cache,
                next_id: AtomicU32::new(1),
                listener: RwLock::new(None),
                budget: DecodeBudget::new(decode_budget),
                inflight: Mutex::new(HashMap::new()),
                pipeline_runs: AtomicUsize::new(0),
                preview: Mutex::new(None),
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

    /// Maior soma de reservas de decodificação simultâneas já vista.
    pub fn decode_peak_bytes(&self) -> usize {
        self.inner.budget.peak.load(Ordering::Relaxed)
    }

    /// Quantas vezes a cadeia de operações foi de fato executada (testes de deduplicação).
    pub fn pipeline_runs(&self) -> usize {
        self.inner.pipeline_runs.load(Ordering::Relaxed)
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, HashMap<DocId, Document>> {
        self.inner.docs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Trava esperando o documento sair do estado de prévia.
    pub(super) fn lock_loaded(&self, id: DocId) -> MutexGuard<'_, HashMap<DocId, Document>> {
        self.inner
            .ready
            .wait_while(self.lock(), |m| m.get(&id).is_some_and(|d| d.loading))
            .unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn next_id(&self) -> DocId {
        DocId(self.inner.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Abre os arquivos em paralelo. Cada um vira um `DocInfo`; os que falham vêm com `error`.
    pub fn open_documents(&self, paths: &[String]) -> Vec<DocInfo> {
        let ids: Vec<DocId> = paths.iter().map(|_| self.next_id()).collect();
        let opened: Vec<(Document, Option<usize>)> = paths
            .par_iter()
            .zip(ids)
            .map(
                |(path, id)| match open_file(Path::new(path), &self.inner.budget) {
                    Ok(Opened::Ready(d)) => {
                        let size = d.frames.first().map_or((0, 0), RgbaImage::dimensions);
                        (Document::new(id, path, d, size, false), None)
                    }
                    Ok(Opened::Preview {
                        preview,
                        full_size,
                        estimate,
                    }) => {
                        let size = full_size.unwrap_or_else(|| preview.frames[0].dimensions());
                        (Document::new(id, path, preview, size, true), Some(estimate))
                    }
                    Err(e) => (Document::failed(id, path, e), None),
                },
            )
            .collect();
        let mut infos = Vec::with_capacity(opened.len());
        let mut pending = Vec::new();
        {
            let mut map = self.lock();
            for (doc, estimate) in opened {
                infos.push(doc.info.clone());
                if let Some(e) = estimate {
                    pending.push((doc.info.id, doc.info.path.clone(), e));
                }
                map.insert(doc.info.id, doc);
            }
        }
        for (id, path, estimate) in pending {
            let store = self.clone();
            // Thread própria: esperar o orçamento não pode prender o pool do rayon.
            // Relê o arquivo (em geral ainda no page cache) em vez de reter os bytes
            // da abertura até a decodificação completa.
            std::thread::spawn(move || {
                let full = {
                    let _r = store.inner.budget.reserve(estimate);
                    decode::decode(Path::new(&path))
                };
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
                Ok(d) => {
                    doc.full_size = d.frames.first().map_or((0, 0), RgbaImage::dimensions);
                    doc.source = Arc::new(d);
                }
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
        self.invalidate(id);
        removed.map(|_| ()).ok_or_else(|| not_found(id))
    }

    /// Descarta renders em cache do documento (o original ou a lista de operações mudou).
    pub(super) fn invalidate(&self, id: DocId) {
        {
            let mut preview = self.inner.preview.lock().unwrap_or_else(|e| e.into_inner());
            if preview.as_ref().is_some_and(|((d, ..), _)| *d == id) {
                *preview = None;
            }
        }
        self.inner.cache.remove_doc(id);
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
        self.pixels(id, frame, false).map(|(p, ..)| p)
    }

    /// Pixels atuais, dimensões lógicas (resolução cheia), a escala lógica→pixels
    /// (< 1 só durante a prévia) e o estado do documento que eles refletem.
    fn pixels(
        &self,
        id: DocId,
        frame: u32,
        allow_preview: bool,
    ) -> AppResult<(Pixels, (u32, u32), f64, RenderState)> {
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
        let n = doc.ops.len();
        let generation = doc.generation;
        let state = (n, generation);
        if doc.loading {
            let scale = doc.source.frames[0].width() as f64 / doc.full_size.0.max(1) as f64;
            return Ok((
                Pixels::Source(doc.source.clone(), 0),
                doc.full_size,
                scale,
                state,
            ));
        }
        let size = doc.size_after_ops();
        if n == 0 {
            return Ok((Pixels::Source(doc.source.clone(), f), size, 1.0, state));
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
            return Ok((
                Pixels::Owned(base.expect("encontrado no cache")),
                size,
                1.0,
                state,
            ));
        }
        let tail = doc.ops[k..n].to_vec();
        let source = doc.source.clone();
        drop(map);

        // Renders iguais em andamento esperam o primeiro em vez de repetir o pipeline.
        let key = (id, n, frame, generation);
        let cell = self
            .inner
            .inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key)
            .or_default()
            .clone();
        let out = cell
            .get_or_init(|| {
                self.inner.pipeline_runs.fetch_add(1, Ordering::Relaxed);
                let mut cur: Option<RgbaImage> = None;
                for op in &tail {
                    let input = cur
                        .as_ref()
                        .or(base.as_deref())
                        .unwrap_or(&source.frames[f]);
                    cur = Some(ops::apply(input, op));
                }
                let out = Arc::new(cur.expect("ao menos uma operação"));
                if self
                    .lock()
                    .get(&id)
                    .is_some_and(|d| d.generation == generation && d.ops.len() >= n)
                {
                    cache.insert((id, n, frame), out.clone());
                }
                out
            })
            .clone();
        let mut inflight = self
            .inner
            .inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if inflight.get(&key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(&key);
        }
        Ok((Pixels::Owned(out), size, 1.0, state))
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
        self.render_view_state(id, frame, max_w, max_h, region)
            .map(|(buf, _)| buf)
    }

    /// `render_view` e o estado do documento que o buffer reflete.
    fn render_view_state(
        &self,
        id: DocId,
        frame: u32,
        max_w: u32,
        max_h: u32,
        region: Option<Rect>,
    ) -> AppResult<(Vec<u8>, RenderState)> {
        let (px, (w, h), scale, state) = self.pixels(id, frame, true)?;
        let region = region.map_or(Rect { x: 0, y: 0, w, h }, |r| ops::clamp_rect(r, w, h));
        let (out_w, out_h) = thumb::fit_size(region.w, region.h, max_w, max_h);
        let src = if scale == 1.0 {
            region
        } else {
            let s = |v: u32| (v as f64 * scale).round() as u32;
            let r = Rect {
                x: s(region.x),
                y: s(region.y),
                w: s(region.w),
                h: s(region.h),
            };
            ops::clamp_rect(r, px.width(), px.height())
        };
        Ok((thumb::view_buffer(&px, src, out_w, out_h), state))
    }

    /// Quadro 0 inteiro reduzido para `max_w`x`max_h` (como `render_view`), guardado num
    /// cache de 1 entrada: os ajustes de cor repetem a prévia sem refazer a redução.
    /// A chave inclui `ops.len()` e `generation`, então editar o documento a invalida.
    pub fn preview_base(&self, id: DocId, max_w: u32, max_h: u32) -> AppResult<Arc<Vec<u8>>> {
        let lock = || self.inner.preview.lock().unwrap_or_else(|e| e.into_inner());
        let state = self.with_doc(id, |d| (d.ops.len(), d.generation))?;
        if let Some((k, buf)) = lock().as_ref()
            && *k == (id, state, max_w, max_h)
        {
            return Ok(buf.clone());
        }
        // A chave guardada é a do estado que o render de fato usou.
        let (buf, state) = self.render_view_state(id, 0, max_w, max_h, None)?;
        let buf = Arc::new(buf);
        *lock() = Some(((id, state, max_w, max_h), buf.clone()));
        Ok(buf)
    }

    pub fn thumbnail(&self, id: DocId, frame: u32, size: u32) -> AppResult<Vec<u8>> {
        self.render_view(id, frame, size, size, None)
    }
}

pub(super) fn not_found(id: DocId) -> AppError {
    AppError::NotFound(format!("documento {} não está aberto", id.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::image::Rgba;

    /// Região de 1 px lógico durante a prévia (escala 1/4): o lado escalado arredonda
    /// para 0 e o `clamp_rect` o leva a 1; nos cantos, o recorte fica dentro da prévia.
    #[test]
    fn regiao_minima_na_previa_vira_um_pixel() {
        let store = DocStore::new();
        let id = store.next_id();
        let preview = RgbaImage::from_fn(100, 75, |x, y| Rgba([x as u8, y as u8, 7, 255]));
        let decoded = Decoded::single(preview, SourceFormat::Jpeg);
        store.lock().insert(
            id,
            Document::new(id, "/tmp/previa.jpg", decoded, (400, 300), true),
        );
        let px = |x, y| {
            let r = Rect { x, y, w: 1, h: 1 };
            let buf = store.render_view(id, 0, 64, 64, Some(r)).unwrap();
            assert_eq!(thumb::view_buffer_size(&buf), Some((1, 1)), "{r:?}");
            [buf[8], buf[9], buf[10], buf[11]]
        };
        assert_eq!(px(0, 0), [0, 0, 7, 255]);
        assert_eq!(px(399, 299), [99, 74, 7, 255]);
        assert_eq!(px(42, 21), [11, 5, 7, 255]);
    }

    /// A decodificação completa relê o arquivo no próprio thread (os bytes da abertura
    /// não ficam retidos): se ele sumir antes, o documento termina com erro, sem travar.
    #[test]
    fn decodificacao_completa_rele_o_arquivo() {
        let dir = std::env::temp_dir().join(format!("gvi-rele-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("grande.jpg");
        let img = ::image::RgbImage::from_pixel(2100, 2000, ::image::Rgb([90, 120, 30]));
        img.save(&path).unwrap();

        let store = DocStore::new();
        // Orçamento cheio: o thread do decode completo espera antes de ler o arquivo.
        let cheio = store.inner.budget.reserve(DEFAULT_DECODE_BUDGET);
        let info = store
            .open_documents(&[path.to_string_lossy().into_owned()])
            .remove(0);
        assert_eq!(info.error, None);
        assert!(
            store.with_doc(info.id, |d| d.loading).unwrap(),
            "abre pela prévia"
        );
        std::fs::remove_dir_all(&dir).unwrap();
        drop(cheio);
        assert!(store.wait_ready(info.id).is_err());
        assert!(store.info(info.id).unwrap().error.is_some());
    }
}
