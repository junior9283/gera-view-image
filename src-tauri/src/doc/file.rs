//! Arquivo: salvar, exportar, estimar tamanho, reverter, renomear, mover e duplicar.
//!
//! Salvar nunca sobrescreve uma versão que mudou por fora: compara tamanho e mtime com o
//! carimbo da abertura (ou do último salvar) e falha com `changed_on_disk`.
use super::{
    color::Profile,
    model::{DocId, DocInfo, Op, SourceFormat},
    store::{DeepBase, DiskStamp, DocStore, Document, Pixels, RenderState, not_found},
};
use crate::{
    error::{AppError, AppResult},
    fsio,
    image::{
        decode::{self, Decoded},
        container::{self, TiffJoin},
        encode::{self, ExportFormat, ExportOptions, MetaCarry},
        metadata, metaedit,
        raster::{self, Rgba16Image},
        thumb::fit_size,
    },
};
use ::image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved(DocInfo),
    /// O documento não pode ser gravado no próprio arquivo: a interface abre Exportar.
    NeedsExport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertTarget {
    /// Relê o arquivo do disco.
    LastSaved,
    /// Volta ao estado da abertura (sem operações).
    Original,
}

/// Acima disto (pixels), a estimativa codifica uma amostra reduzida e extrapola pela área.
const ESTIMATE_MAX_PIXELS: u64 = 1_500_000;

fn changed_on_disk(path: &str, removed: bool) -> AppError {
    AppError::ChangedOnDisk(if removed {
        format!("{path} foi apagado ou movido")
    } else {
        format!("{path} foi alterado fora do app")
    })
}

/// Nome de arquivo simples (sem barra, não vazio, nem `.`/`..`).
fn valid_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(AppError::Io(format!("nome inválido: {name:?}")));
    }
    Ok(name)
}

fn exists_error(p: &Path) -> AppError {
    AppError::Io(format!("{} já existe", p.display()))
}

/// Move `from` para `to` sem sobrescrever; entre discos, copia e apaga o original.
///
/// `rename` substituiria em silêncio um arquivo criado entre a checagem e a troca; o
/// `hard_link` falha atomicamente se o destino existir. Sem hard link (outro disco, FAT),
/// copia para um destino aberto com `create_new` (também sem substituir).
fn move_file(from: &Path, to: &Path) -> AppResult<()> {
    use std::io::ErrorKind;
    match std::fs::hard_link(from, to) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Err(exists_error(to)),
        Err(_) => copy_no_replace(from, to)?,
    }
    std::fs::remove_file(from).inspect_err(|_| {
        let _ = std::fs::remove_file(to);
    })?;
    Ok(())
}

/// Copia `from` para `to` sem substituir (`create_new`). O destino nasce com 0o600 e recebe o
/// modo da origem pelo próprio handle: nunca fica mais aberto que a origem, nem por um instante,
/// e um arquivo trocado no caminho durante a cópia não é afetado.
pub fn copy_no_replace(from: &Path, to: &Path) -> AppResult<()> {
    use std::{io::ErrorKind, os::unix::fs::OpenOptionsExt};
    let mut src = std::fs::File::open(from)?;
    let perms = src.metadata()?.permissions();
    let mut dest = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(to)
        .map_err(|e| match e.kind() {
            ErrorKind::AlreadyExists => exists_error(to),
            _ => e.into(),
        })?;
    let copied = std::io::copy(&mut src, &mut dest)
        .and_then(|_| dest.set_permissions(perms))
        .and_then(|_| dest.sync_all());
    if let Err(e) = copied {
        drop(dest);
        let _ = std::fs::remove_file(to);
        return Err(e.into());
    }
    Ok(())
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Arquivo de origem em memória, para ler o que uma gravação leva dele (metadados, 16 bits).
struct SourceFile {
    bytes: Vec<u8>,
    /// TIFF de várias páginas: o IFD de cada uma. Se o disco tiver outro número de páginas que o
    /// documento, elas casam por índice até onde houver.
    pages: Vec<u64>,
}

impl SourceFile {
    fn read(path: &str, frames: u32) -> Option<Self> {
        if path.is_empty() {
            return None;
        }
        let bytes = crate::fsio::read_regular(Path::new(path)).ok()?;
        let pages = container::tiff_pages(&bytes)
            .filter(|p| p.len() > 1 && frames > 1)
            .unwrap_or_default();
        Some(SourceFile { bytes, pages })
    }

    /// Os bytes com a página `frame` como primeira. `None` se o arquivo não tem essa página.
    fn page(&mut self, frame: u32) -> Option<&[u8]> {
        match self.pages.get(frame as usize) {
            Some(&off) => container::tiff_set_first(&mut self.bytes, off),
            None if frame > 0 => return None,
            None => {}
        }
        Some(&self.bytes)
    }
}

/// Bytes prontos para gravar e o que a gravação muda no documento.
struct Encoded {
    bytes: Vec<u8>,
    /// Ver `metaedit::notes`; `tiffValueDropped`: uma tag de alguma página ficou de fora (`TiffJoin::lost`).
    notes: Vec<&'static str>,
    /// Alguma página foi gravada com os 16 bits de verdade.
    deep: bool,
    state: RenderState,
}

impl Document {
    /// DPI da página `frame`: o do último Ajustar Tamanho que o definiu, senão o do arquivo.
    fn dpi(&self, frame: u32) -> Option<(f32, f32)> {
        self.ops
            .iter()
            .rev()
            .filter(|op| op.touches(frame))
            .find_map(|op| match op.inner() {
                Op::Resize { dpi: Some(d), .. } => Some((*d, *d)),
                _ => None,
            })
            .or(self.source.dpi_of(frame))
    }

    /// `None`: o disco bate com o carimbo. `Some(true)`: apagado/movido. `Some(false)`: alterado.
    fn disk_change(&self) -> Option<bool> {
        if self.info.path.is_empty() || self.disk.is_none() {
            return None;
        }
        match DiskStamp::of(Path::new(&self.info.path)) {
            None => Some(true),
            Some(s) if Some(s) != self.disk => Some(false),
            Some(_) => None,
        }
    }

    /// `Document::deep` do estado que acabou de ser gravado.
    pub(super) fn deep_base(&self, (n, generation): RenderState) -> DeepBase {
        DeepBase { source: Arc::downgrade(&self.source), generation, n, disk: self.disk }
    }

    /// Passa a apontar para `path` (após renomear, mover ou exportar um documento sem caminho).
    pub(super) fn relocate(&mut self, path: &Path) {
        self.info.path = path.to_string_lossy().into_owned();
        self.info.name = file_name(path);
        self.disk = DiskStamp::of(path);
        self.unseen_disk = false;
    }
}

impl DocStore {
    pub fn current_dpi(&self, id: DocId, frame: u32) -> AppResult<Option<(f32, f32)>> {
        self.with_doc(id, |d| d.dpi(frame))
    }

    /// Tamanho de cada página a imprimir ou exportar em PDF: todas as de um TIFF, só o primeiro
    /// quadro de uma animação.
    pub fn page_sizes(&self, id: DocId) -> AppResult<Vec<(u32, u32)>> {
        self.with_doc(id, |d| match d.page_sizes() {
            pages if pages.is_empty() => vec![d.size_after_ops(0)],
            pages => pages,
        })
    }

    /// Ver [`Document::disk_change`].
    pub fn disk_change(&self, id: DocId) -> AppResult<Option<bool>> {
        self.with_doc(id, Document::disk_change)
    }

    /// Aceita a versão atual do disco como referência (se o arquivo ainda existir).
    pub fn accept_disk(&self, id: DocId) -> AppResult<()> {
        let mut map = self.lock();
        let d = map.get_mut(&id).ok_or_else(|| not_found(id))?;
        if let Some(s) = DiskStamp::of(Path::new(&d.info.path)) {
            d.disk = Some(s);
            d.unseen_disk = true;
        }
        Ok(())
    }

    /// `(id, caminho)` dos documentos ligados a um arquivo (para o vigia de alterações).
    pub fn watched_paths(&self) -> Vec<(DocId, String)> {
        self.lock()
            .values()
            .filter(|d| !d.info.path.is_empty() && d.disk.is_some())
            .map(|d| (d.info.id, d.info.path.clone()))
            .collect()
    }

    /// Pixels finais da página `frame`, os metadados a levar (os do documento na primeira página;
    /// nas outras, os da própria página no arquivo, com as edições de texto e palavras-chave) e o
    /// estado que os pixels refletem.
    fn render_for_write(
        &self,
        id: DocId,
        frame: u32,
        keywords: Option<Vec<String>>,
        file: Option<&mut SourceFile>,
    ) -> AppResult<(Pixels, MetaCarry, RenderState)> {
        let (px, _, _, state) = self.pixels(id, frame, false)?;
        let (source, dpi, resized, icc, assigned) = self.with_doc(id, |d| {
            let profile = d.profile(frame);
            let dpi = d.dpi(frame);
            let assigned = matches!(profile, Some(Profile::Assigned(_)));
            (d.source.clone(), dpi, dpi != d.source.dpi_of(frame), profile.map(|p| p.bytes().to_vec()), assigned)
        })?;
        let bytes = file.and_then(|f| f.page(frame));
        let (iptc, xmp) = bytes.map(metadata::file_iim_xmp).unwrap_or_default();
        let text_edits = self.meta_edits(id);
        let cleared = self.meta_cleared(id);
        let exif_keywords = keywords.is_some() || cleared.keywords;
        let meta = if frame == 0 || !source.has_pages() {
            MetaCarry {
                exif: source.exif.clone(),
                icc,
                iptc,
                xmp,
                iptc_keywords: keywords,
                text_edits,
                exif_cleared: Some(cleared.text).filter(|c| !c.is_empty()),
                exif_keywords,
                dpi,
            }
        } else {
            let exif = bytes.and_then(container::tiff_exif_block);
            let (page_icc, page_dpi) = bytes.map_or((icc.clone(), dpi), decode::tiff_page_info);
            // Editar vale em todas as páginas: o campo que a página tem recebe o valor novo (o antigo
            // não pode sobrar nela); o que ela não tem não é criado, só sai algum resto dele do EXIF.
            let (has, has_keywords) = metadata::page_texts(iptc.as_deref(), xmp.as_deref(), exif.as_deref());
            let (text_edits, absent) = text_edits.map_or((None, None), |e| e.split_present(&has));
            MetaCarry {
                icc: if assigned { icc } else { page_icc },
                dpi: if resized { dpi } else { page_dpi },
                iptc_keywords: keywords.filter(|_| has_keywords),
                text_edits,
                exif_cleared: absent,
                exif_keywords,
                exif,
                iptc,
                xmp,
            }
        };
        Ok((px, meta, state))
    }

    /// Pixels finais da página em 16 bits, se ela veio de um PNG/TIFF de 16 bits: as operações
    /// `ops[..n]` (o estado dos pixels de 8 bits `px`) são refeitas em 16 bits sobre o arquivo
    /// atual `file` (com a página como primeira). Ele vale como base se ainda for a origem (confere com os pixels de
    /// 8 bits) ou se for o último Salvar em 16 bits (`Document::deep`): aí só o resto é refeito.
    fn render_deep(
        &self,
        id: DocId,
        frame: u32,
        file: Option<&[u8]>,
        px: &RgbaImage,
        (n, generation): RenderState,
    ) -> Option<Rgba16Image> {
        let (source, ops, saved) = self
            .with_doc(id, |d| {
                let saved = d
                    .deep
                    .as_ref()
                    .filter(|b| {
                        std::ptr::eq(b.source.as_ptr(), Arc::as_ptr(&d.source))
                            && b.generation == generation
                            && b.n <= n
                            && b.disk.is_some()
                            && b.disk == d.disk
                    })
                    .map(|b| b.n);
                let ops = (d.generation == generation)
                    .then(|| d.ops.get(..n).map(<[Op]>::to_vec))
                    .flatten();
                (d.source.clone(), ops, saved)
            })
            .ok()?;
        let ops = ops?;
        let base = raster::decode16(file?, source.format)?;
        let start = match saved {
            Some(k) => k,
            None if source.frames.get(frame as usize).is_some_and(|f| raster::matches8(&base, f)) => 0,
            None => return None,
        };
        let out = ops[start..]
            .iter()
            .filter(|op| op.touches(frame))
            .fold(base, |img, op| raster::apply16(&img, op));
        (out.dimensions() == px.dimensions()).then_some(out)
    }

    /// Codifica a página `opts.frame`. `keep_depth` (Salvar): PNG/TIFF de 16 bits continua com 16 bits.
    fn encode_page(
        &self,
        id: DocId,
        opts: &ExportOptions,
        keywords: Option<Vec<String>>,
        file: &mut Option<SourceFile>,
        keep_depth: bool,
    ) -> AppResult<Encoded> {
        let frame = opts.frame;
        let (px, meta, state) = self.render_for_write(id, frame, keywords, file.as_mut())?;
        // Exportar em 16 bits (ou EXR) de uma origem de 16 bits usa os 16 bits de verdade.
        let deep = (opts.deep() || (keep_depth && matches!(opts.format, ExportFormat::Png | ExportFormat::Tiff)))
            .then(|| self.render_deep(id, frame, file.as_mut()?.page(frame), &px, state))
            .flatten();
        let mut opts = opts.clone();
        opts.depth16 |= deep.is_some();
        if opts.all_pages {
            // Cada página tem a própria proporção: cabe no tamanho pedido, sem ampliar.
            opts.resize = opts.resize.map(|(w, h)| fit_size(px.width(), px.height(), w, h));
        }
        let bytes = match &deep {
            Some(d) => encode::encode(d, &opts, &meta)?,
            None => encode::encode(&*px, &opts, &meta)?,
        };
        Ok(Encoded { bytes, notes: metaedit::notes(&meta, &opts), deep: deep.is_some(), state })
    }

    /// Codifica o documento: a página `opts.frame` ou, num TIFF com `all_pages`, todas.
    fn encode_doc(
        &self,
        id: DocId,
        opts: &ExportOptions,
        keywords: Option<Vec<String>>,
        mut file: Option<SourceFile>,
        keep_depth: bool,
    ) -> AppResult<Encoded> {
        let Some(n) = self.written_pages(id, opts)? else {
            let one = ExportOptions { all_pages: false, ..opts.clone() };
            return self.encode_page(id, &one, keywords, &mut file, keep_depth);
        };
        // Uma edição no meio misturaria estados diferentes entre as páginas: recomeça.
        'again: for _ in 0..3 {
            let mut join = TiffJoin::new(decode::MAX_DECODE_BYTES);
            let mut all: Option<Encoded> = None;
            for frame in 0..n {
                let one = ExportOptions { frame, ..opts.clone() };
                let page = self.encode_page(id, &one, keywords.clone(), &mut file, keep_depth)?;
                if all.as_ref().is_some_and(|a| a.state != page.state) {
                    continue 'again;
                }
                join.push(&page.bytes).ok_or_else(|| {
                    AppError::TooLarge(format!("as {n} páginas passam de 2 GB; exporte em partes ou comprima"))
                })?;
                match &mut all {
                    None => all = Some(Encoded { bytes: Vec::new(), ..page }),
                    Some(a) => {
                        a.deep |= page.deep;
                        for note in page.notes {
                            if !a.notes.contains(&note) {
                                a.notes.push(note);
                            }
                        }
                    }
                }
            }
            if let Some(mut all) = all {
                if join.lost() {
                    all.notes.push("tiffValueDropped");
                }
                return Ok(Encoded { bytes: join.finish(), ..all });
            }
        }
        Err(AppError::Io("o documento mudou durante a gravação".into()))
    }

    /// Quantas páginas `opts` grava, se forem todas as de um documento de várias.
    fn written_pages(&self, id: DocId, opts: &ExportOptions) -> AppResult<Option<u32>> {
        let all = opts.all_pages && opts.format == ExportFormat::Tiff;
        self.with_doc(id, |d| (all && d.source.has_pages()).then_some(d.info.frames))
    }

    /// O que Salvar precisa para gravar no próprio arquivo, ou `None` se tiver de virar Exportar
    /// (formato sem gravação, ou o arquivo no disco virou outra coisa). Não altera nada. É a
    /// checagem completa de `save`, que decide de verdade e protege contra a corrida entre a
    /// sondagem de `save_needs_export` e a gravação.
    fn save_plan(&self, id: DocId) -> AppResult<Option<(String, ExportFormat, Option<SourceFile>)>> {
        let (path, format, writable, frames, unseen) = self.with_doc(id, |d| {
            (d.info.path.clone(), d.info.format, d.info.writable, d.info.frames, d.unseen_disk)
        })?;
        let Some(fmt) = ExportFormat::for_save(format).filter(|_| writable) else {
            return Ok(None);
        };
        if let Some(removed) = self.disk_change(id)? {
            return Err(changed_on_disk(&path, removed));
        }
        let file = SourceFile::read(&path, frames);
        // O arquivo pode ter virado outra coisa: gravar por cima perderia as páginas ou o formato dele.
        if let Some(f) = &file {
            let same = decode::detect_format(Path::new(&path), &f.bytes) == Some(format);
            let loses = |f: &SourceFile| {
                decode::decode_bytes(Path::new(&path), &f.bytes)
                    .map_or(true, |d| d.frames.len() > frames as usize)
            };
            if !same || (unseen && loses(f)) {
                return Ok(None);
            }
        }
        Ok(Some((path, fmt, file)))
    }

    /// Salvar vai virar Exportar? A interface pergunta antes de achatar anotações: cancelar o
    /// Exportar não pode deixar o documento mudado. Sondagem leve, sem decodificar nada: só o
    /// começo do arquivo (formato) e, num TIFF com páginas novas no disco, a contagem delas. O
    /// que só uma decodificação mostraria fica para `save_plan`, dentro de `save`.
    pub fn save_needs_export(&self, id: DocId) -> AppResult<bool> {
        self.wait_ready(id)?;
        let (path, format, writable, frames, unseen) = self.with_doc(id, |d| {
            (d.info.path.clone(), d.info.format, d.info.writable, d.info.frames, d.unseen_disk)
        })?;
        if ExportFormat::for_save(format).is_none() || !writable {
            return Ok(true);
        }
        if let Some(removed) = self.disk_change(id)? {
            return Err(changed_on_disk(&path, removed));
        }
        let p = Path::new(&path);
        let Ok(head) = fsio::read_head(p, 64) else {
            return Ok(false); // sem arquivo para conferir: `save` decide
        };
        if decode::detect_format(p, &head) != Some(format) {
            return Ok(true);
        }
        Ok(unseen
            && format == SourceFormat::Tiff
            && fsio::read_regular(p)
                .map_or(true, |b| container::tiff_pages(&b).map_or(true, |pages| pages.len() > frames as usize)))
    }

    /// Salvar (Ctrl+S): grava no próprio arquivo, de forma atômica, se o formato permitir (um TIFF
    /// leva todas as páginas). `keywords`: palavras-chave editadas no inspetor (substituem as do arquivo).
    pub fn save(&self, id: DocId, keywords: Option<Vec<String>>) -> AppResult<SaveOutcome> {
        self.wait_ready(id)?;
        let Some((path, fmt, file)) = self.save_plan(id)? else {
            return Ok(SaveOutcome::NeedsExport);
        };
        let bytes = file.as_ref().map(|f| f.bytes.as_slice());
        let quality = match fmt {
            ExportFormat::Jpeg => bytes.and_then(encode::jpeg_quality),
            // WebP com perda: sem como estimar a qualidade, usa 90; sem perdas continua sem perdas.
            ExportFormat::Webp if bytes.is_some_and(webp_is_lossy) => Some(90),
            _ => None,
        };
        let opts = ExportOptions { quality, all_pages: true, ..ExportOptions::new(fmt) };
        let wrote_keywords = keywords.is_some();
        let out = self.encode_doc(id, &opts, keywords, file, true)?;
        // Lote 5: guarda a versão atual e mantém as etiquetas (xattr `user.*`).
        super::finder::overwrite(Path::new(&path), &out.bytes)?;
        self.add_meta_notes(id, &out.notes);
        self.meta_written(id, fmt.carries_text());
        if wrote_keywords {
            self.keywords_written(id);
        }
        let (_, info) = self.with_doc_mut(id, |d| {
            d.disk = DiskStamp::of(Path::new(&path));
            d.unseen_disk = false;
            d.mark_saved(out.state, None);
            d.deep = out.deep.then(|| d.deep_base(out.state));
        })?;
        Ok(SaveOutcome::Saved(info))
    }

    /// Exporta para `dest`. Um documento sem caminho (duplicado, colado, capturado) passa a ser
    /// o arquivo exportado, se o formato for regravável e não houver redimensionamento.
    pub fn export(
        &self,
        id: DocId,
        dest: &str,
        opts: &ExportOptions,
        keywords: Option<Vec<String>>,
    ) -> AppResult<()> {
        let dest_path = PathBuf::from(dest);
        let (path, frames) = self.with_doc(id, |d| (d.info.path.clone(), d.info.frames))?;
        let same_file = !path.is_empty() && Path::new(&path) == dest_path;
        if same_file && let Some(removed) = self.disk_change(id)? {
            return Err(changed_on_disk(&path, removed));
        }
        let page = self.written_page(id, opts)?;
        let wrote_keywords = keywords.is_some();
        let out = self.encode_doc(id, opts, keywords, SourceFile::read(&path, frames), false)?;
        super::finder::overwrite(&dest_path, &out.bytes)?;
        self.add_meta_notes(id, &out.notes);
        let adopt = path.is_empty()
            && opts.resize.is_none()
            && ExportFormat::for_save(opts.format.source_format()).is_some();
        if adopt || same_file {
            self.meta_written(id, opts.format.carries_text());
            if wrote_keywords {
                self.keywords_written(id);
            }
            self.with_doc_mut(id, |d| {
                if adopt {
                    d.relocate(&dest_path);
                    d.opened_disk = d.disk;
                    d.set_format(opts.format.source_format());
                    d.mark_saved(out.state, page);
                } else {
                    d.disk = DiskStamp::of(&dest_path);
                    d.unseen_disk = false;
                }
            })?;
        }
        Ok(())
    }

    /// Página que `opts` grava, para o `mark_saved`: `None` = todas.
    pub(super) fn written_page(&self, id: DocId, opts: &ExportOptions) -> AppResult<Option<u32>> {
        Ok(self.written_pages(id, opts)?.is_none().then_some(opts.frame))
    }

    /// Tamanho estimado do arquivo com `opts` (codifica de verdade; imagens grandes por amostra).
    pub fn estimate_size(&self, id: DocId, opts: &ExportOptions) -> AppResult<u64> {
        let Some(n) = self.written_pages(id, opts)? else {
            return self.estimate_page(id, opts);
        };
        let pages = (0..n).map(|frame| {
            let (w, h) = self.with_doc(id, |d| d.size_after_ops(frame))?;
            let resize = opts.resize.map(|(mw, mh)| fit_size(w, h, mw, mh));
            self.estimate_page(id, &ExportOptions { frame, resize, ..opts.clone() })
        });
        pages.sum()
    }

    fn estimate_page(&self, id: DocId, opts: &ExportOptions) -> AppResult<u64> {
        let (px, meta, _) = self.render_for_write(id, opts.frame, None, None)?;
        let (w, h) = opts.resize.unwrap_or(px.dimensions());
        let area = w as u64 * h as u64;
        // O ICO é sempre pequeno (o codificador reduz a 256 px): nada a extrapolar.
        if area <= ESTIMATE_MAX_PIXELS || opts.format == ExportFormat::Ico {
            return Ok(encode::encode(&*px, opts, &meta)?.len() as u64);
        }
        let k = (ESTIMATE_MAX_PIXELS as f64 / area as f64).sqrt();
        let (sw, sh) = (
            ((w as f64 * k).round() as u32).max(1),
            ((h as f64 * k).round() as u32).max(1),
        );
        let sample = MetaCarry {
            dpi: meta.dpi,
            ..MetaCarry::default()
        };
        let small = encode::encode(
            &*px,
            &ExportOptions {
                resize: Some((sw, sh)),
                ..opts.clone()
            },
            &sample,
        )?;
        let meta_len = [meta.exif.as_ref(), meta.icc.as_ref()]
            .into_iter()
            .flatten()
            .map(Vec::len)
            .sum::<usize>() as f64;
        Ok((small.len() as f64 * area as f64 / (sw as u64 * sh as u64) as f64 + meta_len) as u64)
    }

    /// Reverter: `Original` volta às operações vazias sobre a decodificação da abertura;
    /// `LastSaved` relê o arquivo do disco (também serve de "Recarregar").
    pub fn revert(&self, id: DocId, to: RevertTarget) -> AppResult<DocInfo> {
        let fresh = match to {
            RevertTarget::Original => None,
            RevertTarget::LastSaved => Some(decode::decode(&self.file_path(id)?)?),
        };
        let (_, info) = self.with_doc_mut(id, |d| {
            match fresh {
                Some(dec) => {
                    if d.original.is_none() {
                        d.original = Some(d.source.clone());
                    }
                    d.full_size = dec.frames.first().map_or((0, 0), RgbaImage::dimensions);
                    d.source = Arc::new(dec);
                    d.disk = DiskStamp::of(Path::new(&d.info.path));
                    d.unseen_disk = false;
                    d.saved_len = 0;
                }
                None => {
                    if let Some(orig) = d.original.take() {
                        d.full_size = orig.frames.first().map_or((0, 0), RgbaImage::dimensions);
                        d.source = orig;
                    }
                    // O disco pode não ser mais o da abertura: o Salvar confere antes de gravar por cima.
                    d.unseen_disk |= d.disk != d.opened_disk;
                    // Se o disco ainda é o da abertura, o documento volta a ficar limpo.
                    d.saved_len = if d.disk == d.opened_disk {
                        0
                    } else {
                        usize::MAX
                    };
                }
            }
            d.ops.clear();
            d.redo.clear();
            d.generation += 1;
            d.error = None;
            d.set_format(d.source.format);
        })?;
        self.meta_source_changed(id, to == RevertTarget::Original);
        self.invalidate(id);
        Ok(info)
    }

    /// Renomeia o arquivo na mesma pasta (sem sobrescrever).
    pub fn rename(&self, id: DocId, new_name: &str) -> AppResult<DocInfo> {
        let name = valid_name(new_name)?;
        self.move_doc_file(id, |path| path.with_file_name(name))
    }

    /// Move o arquivo para a pasta `dir` (copiar + apagar entre discos; sem sobrescrever).
    pub fn move_to(&self, id: DocId, dir: &str) -> AppResult<DocInfo> {
        self.move_doc_file(id, |path| {
            Path::new(dir).join(path.file_name().unwrap_or_default())
        })
    }

    /// Move o arquivo do documento para `dest(caminho atual)` e passa a apontar para ele.
    fn move_doc_file(&self, id: DocId, dest: impl FnOnce(&Path) -> PathBuf) -> AppResult<DocInfo> {
        let path = self.file_path(id)?;
        let to = dest(&path);
        if to == path {
            return self.info(id);
        }
        move_file(&path, &to)?;
        self.with_doc_mut(id, |d| d.relocate(&to)).map(|(_, i)| i)
    }

    pub(super) fn file_path(&self, id: DocId) -> AppResult<PathBuf> {
        let path = self.info(id)?.path;
        if path.is_empty() {
            return Err(AppError::NotFound("documento sem arquivo".into()));
        }
        Ok(PathBuf::from(path))
    }

    /// Cópia em memória, sem caminho (Salvar vai para Exportar), com as mesmas operações.
    pub fn duplicate(&self, id: DocId, name: &str) -> AppResult<DocInfo> {
        self.wait_ready(id)?;
        let new_id = self.next_id();
        let info = {
            let mut map = self.lock();
            let d = map.get(&id).ok_or_else(|| not_found(id))?;
            let dup =
                Document::untitled(new_id, name, d.source.clone(), d.full_size, d.ops.clone());
            let info = dup.info.clone();
            map.insert(new_id, dup);
            info
        };
        self.inherit_meta(id, new_id);
        Ok(info)
    }

    /// Documento novo sem arquivo (área de transferência, captura de tela).
    pub fn insert_untitled(&self, name: &str, decoded: Decoded) -> DocInfo {
        let id = self.next_id();
        let size = decoded.frames.first().map_or((0, 0), RgbaImage::dimensions);
        let doc = Document::untitled(id, name, decoded, size, Vec::new());
        let info = doc.info.clone();
        self.lock().insert(id, doc);
        info
    }
}

impl Document {
    /// Documento sem caminho (Salvar vai para Exportar) que nasce "não salvo".
    fn untitled(
        id: DocId,
        name: &str,
        source: impl Into<Arc<Decoded>>,
        size: (u32, u32),
        ops: Vec<Op>,
    ) -> Self {
        let mut doc = Document::new(id, "", source, size, false);
        doc.ops = ops;
        doc.info.name = name.to_string();
        doc.saved_len = usize::MAX;
        doc.refresh();
        doc
    }
}

/// WebP com perda (`VP8 `) em vez de sem perdas (`VP8L`).
fn webp_is_lossy(b: &[u8]) -> bool {
    b.windows(4).take(4096).any(|w| w == b"VP8 ")
}

/// Bytes PNG (rápido) do quadro 0 com as operações, em sRGB: usado pelo arraste.
pub fn render_png(store: &DocStore, id: DocId) -> AppResult<Vec<u8>> {
    use ::image::{
        ImageEncoder,
        codecs::png::{CompressionType, FilterType, PngEncoder},
    };
    let px = store.render_full(id, 0)?;
    let px = store.to_srgb(id, 0, std::borrow::Cow::Borrowed(&*px));
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            px.as_raw(),
            px.width(),
            px.height(),
            ::image::ExtendedColorType::Rgba8,
        )
        .map_err(AppError::from)?;
    Ok(out)
}
