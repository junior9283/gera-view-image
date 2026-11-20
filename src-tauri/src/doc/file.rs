//! Arquivo: salvar, exportar, estimar tamanho, reverter, renomear, mover e duplicar.
//!
//! Salvar nunca sobrescreve uma versão que mudou por fora: compara tamanho e mtime com o
//! carimbo da abertura (ou do último salvar) e falha com `changed_on_disk`.
use super::{
    model::{DocId, DocInfo, Op},
    store::{DiskStamp, DocStore, Document, Pixels, not_found},
};
use crate::{
    error::{AppError, AppResult},
    image::{
        decode::{self, Decoded},
        encode::{self, ExportFormat, ExportOptions, MetaCarry},
        metadata,
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

impl Document {
    /// DPI atual: o do último Ajustar Tamanho que o definiu, senão o do arquivo.
    fn dpi(&self) -> Option<(f32, f32)> {
        self.ops
            .iter()
            .rev()
            .find_map(|op| match op {
                Op::Resize { dpi: Some(d), .. } => Some((*d, *d)),
                _ => None,
            })
            .or(self.source.dpi)
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

    /// Passa a apontar para `path` (após renomear, mover ou exportar um documento sem caminho).
    fn relocate(&mut self, path: &Path) {
        self.info.path = path.to_string_lossy().into_owned();
        self.info.name = file_name(path);
        self.disk = DiskStamp::of(path);
    }
}

impl DocStore {
    pub fn current_dpi(&self, id: DocId) -> AppResult<Option<(f32, f32)>> {
        self.with_doc(id, Document::dpi)
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

    /// Pixels finais (quadro 0) e os metadados a levar. `file` = bytes atuais do arquivo (IPTC/XMP).
    fn render_for_write(
        &self,
        id: DocId,
        keywords: Option<Vec<String>>,
        read_file: bool,
    ) -> AppResult<(Pixels, MetaCarry, Option<Vec<u8>>)> {
        let px = self.render_full(id, 0)?;
        let (path, source, dpi) =
            self.with_doc(id, |d| (d.info.path.clone(), d.source.clone(), d.dpi()))?;
        let file = (read_file && !path.is_empty())
            .then(|| std::fs::read(&path).ok())
            .flatten();
        let (iptc, xmp) = file
            .as_deref()
            .map(metadata::jpeg_iim_xmp)
            .unwrap_or_default();
        let meta = MetaCarry {
            exif: source.exif.clone(),
            icc: source.icc.clone(),
            iptc,
            xmp,
            iptc_keywords: keywords,
            dpi,
        };
        Ok((px, meta, file))
    }

    /// Salvar (Ctrl+S): grava no próprio arquivo, de forma atômica, se o formato permitir.
    /// `keywords`: palavras-chave editadas no inspetor (substituem as do arquivo).
    pub fn save(&self, id: DocId, keywords: Option<Vec<String>>) -> AppResult<SaveOutcome> {
        self.wait_ready(id)?;
        let (path, format, writable, n, generation) = self.with_doc(id, |d| {
            (
                d.info.path.clone(),
                d.info.format,
                d.info.writable,
                d.ops.len(),
                d.generation,
            )
        })?;
        let Some(fmt) = ExportFormat::for_save(format).filter(|_| writable) else {
            return Ok(SaveOutcome::NeedsExport);
        };
        if let Some(removed) = self.disk_change(id)? {
            return Err(changed_on_disk(&path, removed));
        }
        let (px, meta, file) = self.render_for_write(id, keywords, true)?;
        let quality = match fmt {
            ExportFormat::Jpeg => file.as_deref().and_then(encode::jpeg_quality),
            // WebP com perda: sem como estimar a qualidade, usa 90; sem perdas continua sem perdas.
            ExportFormat::Webp if file.as_deref().is_some_and(webp_is_lossy) => Some(90),
            _ => None,
        };
        let opts = ExportOptions {
            format: fmt,
            quality,
            alpha: true,
            depth16: false,
            strip_metadata: false,
            resize: None,
        };
        let bytes = encode::encode(&px, &opts, &meta)?;
        encode::write_file_atomic(Path::new(&path), &bytes)?;
        let (_, info) = self.with_doc_mut(id, |d| {
            d.disk = DiskStamp::of(Path::new(&path));
            d.saved_len = if d.generation == generation && d.ops.len() >= n {
                n
            } else {
                usize::MAX
            };
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
        let (path, n, generation) =
            self.with_doc(id, |d| (d.info.path.clone(), d.ops.len(), d.generation))?;
        let same_file = !path.is_empty() && Path::new(&path) == dest_path;
        if same_file && let Some(removed) = self.disk_change(id)? {
            return Err(changed_on_disk(&path, removed));
        }
        let (px, meta, _) = self.render_for_write(id, keywords, true)?;
        let bytes = encode::encode(&px, opts, &meta)?;
        encode::write_file_atomic(&dest_path, &bytes)?;
        let adopt = path.is_empty()
            && opts.resize.is_none()
            && ExportFormat::for_save(opts.format.source_format()).is_some();
        if adopt || same_file {
            self.with_doc_mut(id, |d| {
                if adopt {
                    d.relocate(&dest_path);
                    d.opened_disk = d.disk;
                    d.info.format = opts.format.source_format();
                    d.info.writable =
                        Document::can_save(dest, d.info.format, d.source.frames.len());
                    if d.generation == generation && d.ops.len() >= n {
                        d.saved_len = n;
                    }
                } else {
                    d.disk = DiskStamp::of(&dest_path);
                }
            })?;
        }
        Ok(())
    }

    /// Tamanho estimado do arquivo com `opts` (codifica de verdade; imagens grandes por amostra).
    pub fn estimate_size(&self, id: DocId, opts: &ExportOptions) -> AppResult<u64> {
        let (px, meta, _) = self.render_for_write(id, None, false)?;
        let (w, h) = opts.resize.unwrap_or(px.dimensions());
        let area = w as u64 * h as u64;
        if area <= ESTIMATE_MAX_PIXELS {
            return Ok(encode::encode(&px, opts, &meta)?.len() as u64);
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
            &px,
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
            RevertTarget::LastSaved => {
                let path = self.info(id)?.path;
                if path.is_empty() {
                    return Err(AppError::NotFound("documento sem arquivo".into()));
                }
                Some(decode::decode(Path::new(&path))?)
            }
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
                    d.saved_len = 0;
                }
                None => {
                    if let Some(orig) = d.original.take() {
                        d.full_size = orig.frames.first().map_or((0, 0), RgbaImage::dimensions);
                        d.source = orig;
                    }
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
        })?;
        self.invalidate(id);
        Ok(info)
    }

    /// Renomeia o arquivo na mesma pasta (sem sobrescrever).
    pub fn rename(&self, id: DocId, new_name: &str) -> AppResult<DocInfo> {
        let name = valid_name(new_name)?;
        let path = self.file_path(id)?;
        let to = path.with_file_name(name);
        if to == path {
            return self.info(id);
        }
        move_file(&path, &to)?;
        self.with_doc_mut(id, |d| d.relocate(&to)).map(|(_, i)| i)
    }

    /// Move o arquivo para a pasta `dir` (copiar + apagar entre discos; sem sobrescrever).
    pub fn move_to(&self, id: DocId, dir: &str) -> AppResult<DocInfo> {
        let path = self.file_path(id)?;
        let to = Path::new(dir).join(path.file_name().unwrap_or_default());
        if to == path {
            return self.info(id);
        }
        move_file(&path, &to)?;
        self.with_doc_mut(id, |d| d.relocate(&to)).map(|(_, i)| i)
    }

    fn file_path(&self, id: DocId) -> AppResult<PathBuf> {
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
            let mut dup = Document::new(new_id, "", d.source.clone(), d.full_size, false);
            dup.ops = d.ops.clone();
            dup.info.name = name.to_string();
            dup.saved_len = usize::MAX;
            dup.refresh();
            let info = dup.info.clone();
            map.insert(new_id, dup);
            info
        };
        Ok(info)
    }

    /// Documento novo sem arquivo (área de transferência, captura de tela).
    pub fn insert_untitled(&self, name: &str, decoded: Decoded) -> DocInfo {
        let id = self.next_id();
        let size = decoded.frames.first().map_or((0, 0), RgbaImage::dimensions);
        let mut doc = Document::new(id, "", decoded, size, false);
        doc.info.name = name.to_string();
        doc.saved_len = usize::MAX;
        doc.refresh();
        let info = doc.info.clone();
        self.lock().insert(id, doc);
        info
    }
}

/// WebP com perda (`VP8 `) em vez de sem perdas (`VP8L`).
fn webp_is_lossy(b: &[u8]) -> bool {
    b.windows(4).take(4096).any(|w| w == b"VP8 ")
}

/// Bytes PNG (rápido) do quadro 0 com as operações: usado pela impressão.
pub fn render_png(store: &DocStore, id: DocId) -> AppResult<Vec<u8>> {
    use ::image::{
        ImageEncoder,
        codecs::png::{CompressionType, FilterType, PngEncoder},
    };
    let px = store.render_full(id, 0)?;
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
