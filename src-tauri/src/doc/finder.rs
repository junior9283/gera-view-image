//! Finder no Linux: etiquetas, bloquear, mover para o Lixo, Salvar Como e restaurar versão.
//!
//! - Etiquetas: xattr `user.xdg.tags` (freedesktop "Common Extended Attributes"), o mesmo do
//!   Dolphin/Baloo: UTF-8, separadas por vírgula, sem escape (KFileMetaData `setTags` faz
//!   `join(',')` e `tags()` faz `split(',', SkipEmptyParts)`). Por isso a vírgula é recusada.
//! - Bloquear: tira a permissão de escrita de todos (`chmod a-w`); desbloquear devolve só a do
//!   dono. `chattr +i` exigiria root.
//! - Lixo: portal `org.freedesktop.portal.Trash` (fd aberto sem seguir symlink) e, se não der,
//!   a crate `trash` (especificação freedesktop Trash). Nunca apaga: se não foi para o Lixo,
//!   devolve erro e o arquivo fica onde está.
use super::{
    model::{DocId, DocInfo},
    store::{DeepBase, DocStore, Document},
    versions,
};
use crate::{
    error::{AppError, AppResult},
    image::{
        decode,
        encode::{self, ExportFormat, ExportOptions},
    },
};
use std::{
    ffi::OsString,
    fs,
    io::ErrorKind,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use xattr::FileExt;

pub const TAGS_ATTR: &str = "user.xdg.tags";
/// Teto do valor do xattr (o ext4 aceita cerca de um bloco por inode).
const MAX_TAGS_BYTES: usize = 4000;
const MAX_TAG_CHARS: usize = 255;

/// Etiquetas de um valor de `user.xdg.tags`: sem vazias nem repetidas, na ordem.
pub fn parse_tags(raw: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in String::from_utf8_lossy(raw).split(',') {
        let t = t.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// Limpa a lista (espaços, vazias, repetidas) e recusa o que o formato não representa.
pub fn normalize_tags(tags: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() || out.iter().any(|x| x == t) {
            continue;
        }
        if t.contains(',') || t.chars().any(char::is_control) || t.chars().count() > MAX_TAG_CHARS {
            return Err(AppError::Unsupported(format!("etiqueta inválida: {t:?}")));
        }
        out.push(t.to_string());
    }
    if out.join(",").len() > MAX_TAGS_BYTES {
        return Err(AppError::Unsupported("etiquetas demais para o arquivo".into()));
    }
    Ok(out)
}

/// Abre o arquivo do documento (o que o usuário abriu) e confere que é um arquivo regular.
fn open_regular(path: &Path) -> AppResult<fs::File> {
    let f = fs::File::open(path)?;
    if !f.metadata()?.is_file() {
        return Err(AppError::Unsupported(format!("{} não é um arquivo", path.display())));
    }
    Ok(f)
}

fn xattr_error(e: std::io::Error) -> AppError {
    if e.raw_os_error() == Some(libc::ENOTSUP) {
        AppError::Unsupported("o sistema de arquivos não guarda etiquetas".into())
    } else {
        e.into()
    }
}

pub fn read_tags(path: &Path) -> AppResult<Vec<String>> {
    match open_regular(path)?.get_xattr(TAGS_ATTR) {
        Ok(v) => Ok(v.as_deref().map(parse_tags).unwrap_or_default()),
        Err(e) if e.raw_os_error() == Some(libc::ENOTSUP) => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// Grava as etiquetas (lista vazia remove o atributo). Devolve a lista gravada.
pub fn write_tags(path: &Path, tags: &[String]) -> AppResult<Vec<String>> {
    let tags = normalize_tags(tags)?;
    let f = open_regular(path)?;
    if tags.is_empty() {
        match f.remove_xattr(TAGS_ATTR) {
            Err(e) if e.raw_os_error() != Some(libc::ENODATA) => return Err(xattr_error(e)),
            _ => {}
        }
    } else {
        f.set_xattr(TAGS_ATTR, tags.join(",").as_bytes())
            .map_err(xattr_error)?;
    }
    Ok(tags)
}

/// Bloqueado = ninguém tem permissão de escrita.
pub fn is_locked(path: &Path) -> AppResult<bool> {
    Ok(fs::metadata(path)?.mode() & 0o222 == 0)
}

pub fn set_locked(path: &Path, locked: bool) -> AppResult<()> {
    let f = open_regular(path)?;
    let mode = f.metadata()?.mode() & 0o7777;
    let new = if locked { mode & !0o222 } else { mode | 0o200 };
    if new != mode {
        f.set_permissions(fs::Permissions::from_mode(new))?;
    }
    Ok(())
}

/// Atributos `user.*` do arquivo (etiquetas, comentário, nota...), para sobreviverem à troca
/// atômica do Salvar (o arquivo novo nasce sem eles).
fn user_xattrs(path: &Path) -> Vec<(OsString, Vec<u8>)> {
    let Ok(f) = open_regular(path) else {
        return Vec::new();
    };
    let Ok(names) = f.list_xattr() else {
        return Vec::new();
    };
    names
        .filter(|n| n.as_encoded_bytes().starts_with(b"user."))
        .filter_map(|n| Some((n.clone(), f.get_xattr(&n).ok()??)))
        .collect()
}

/// Sobrescreve `path` de forma atômica: guarda antes a versão atual (se as versões estiverem
/// ligadas) e mantém os atributos `user.*`. Falha ao guardar a versão não impede o Salvar.
pub fn overwrite(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some((root, max)) = versions::current()
        && let Err(e) = versions::snapshot(&root, path, max)
    {
        eprintln!("gera-view-image: versão de {} não guardada: {e}", path.display());
    }
    let attrs = user_xattrs(path);
    encode::write_file_atomic(path, bytes)?;
    if !attrs.is_empty()
        && let Ok(f) = open_regular(path)
    {
        for (name, value) in attrs {
            let _ = f.set_xattr(&name, &value);
        }
    }
    Ok(())
}

// ---------- Lixo ----------

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";

/// `Trash.TrashFile` do portal com um fd do próprio arquivo (sem seguir symlink, conferindo
/// que é o mesmo inode do `before`). O portal exige fd gravável.
fn portal_trash(path: &Path, before: &fs::Metadata) -> Result<(), String> {
    let f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    let m = f.metadata().map_err(|e| e.to_string())?;
    if (m.dev(), m.ino()) != (before.dev(), before.ino()) || !m.is_file() {
        return Err("o arquivo mudou durante a abertura".into());
    }
    let conn = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let proxy = zbus::blocking::Proxy::new(&conn, PORTAL_DEST, PORTAL_PATH, "org.freedesktop.portal.Trash")
        .map_err(|e| e.to_string())?;
    use std::os::fd::AsFd;
    let code: u32 = proxy
        .call("TrashFile", &(zbus::zvariant::Fd::from(f.as_fd()),))
        .map_err(|e| e.to_string())?;
    if code == 1 { Ok(()) } else { Err(format!("portal devolveu {code}")) }
}

/// Move `path` para o Lixo (portal se `portal`, senão/ou depois a crate `trash`). Symlink vai
/// como symlink (o alvo fica). Nunca apaga: sem Lixo, devolve erro.
pub fn trash(path: &Path, portal: bool) -> AppResult<()> {
    let before = fs::symlink_metadata(path)?;
    let ft = before.file_type();
    if !ft.is_file() && !ft.is_symlink() {
        return Err(AppError::Unsupported(format!("{} não é um arquivo", path.display())));
    }
    let via_portal = portal && ft.is_file() && portal_trash(path, &before).is_ok();
    if !via_portal {
        trash::delete(path)
            .map_err(|e| AppError::Io(format!("não foi possível mover para o Lixo: {e}")))?;
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Ok(m) if (m.dev(), m.ino()) == (before.dev(), before.ino()) => {
            Err(AppError::Io("o arquivo continua no lugar".into()))
        }
        _ => Ok(()),
    }
}

// ---------- documento ----------

impl DocStore {
    pub fn file_tags(&self, id: DocId) -> AppResult<Vec<String>> {
        read_tags(&self.file_path(id)?)
    }

    pub fn set_file_tags(&self, id: DocId, tags: &[String]) -> AppResult<Vec<String>> {
        write_tags(&self.file_path(id)?, tags)
    }

    pub fn file_locked(&self, id: DocId) -> AppResult<bool> {
        is_locked(&self.file_path(id)?)
    }

    /// Bloqueia/desbloqueia e recalcula se o Salvar grava no próprio arquivo.
    pub fn set_locked(&self, id: DocId, locked: bool) -> AppResult<DocInfo> {
        let path = self.file_path(id)?;
        set_locked(&path, locked)?;
        self.with_doc_mut(id, |d| {
            d.info.writable =
                Document::can_save(&d.info.path, d.info.format, d.source.frames.len());
        })
        .map(|(_, i)| i)
    }

    pub fn move_to_trash(&self, id: DocId) -> AppResult<()> {
        trash(&self.file_path(id)?, true)
    }

    /// Salvar Como…: grava em `dest` e o documento passa a ser esse arquivo (só formatos que o
    /// Salvar regrava, sem redimensionar).
    pub fn save_as(
        &self,
        id: DocId,
        dest: &str,
        opts: &ExportOptions,
        keywords: Option<Vec<String>>,
    ) -> AppResult<DocInfo> {
        let format = opts.format.source_format();
        if opts.resize.is_some() || ExportFormat::for_save(format).is_none() {
            return Err(AppError::Unsupported(
                "Salvar Como grava só JPEG, PNG, TIFF, WebP, AVIF ou BMP".into(),
            ));
        }
        self.wait_ready(id)?;
        let (n, generation) = self.with_doc(id, |d| (d.ops.len(), d.generation))?;
        self.export(id, dest, opts, keywords)?;
        let dest_path = Path::new(dest);
        self.with_doc_mut(id, |d| {
            d.relocate(dest_path);
            d.info.format = format;
            d.opened_disk = d.disk;
            d.info.writable = Document::can_save(dest, format, d.source.frames.len());
            let same = d.generation == generation && d.ops.len() >= n;
            d.saved_len = if same { n } else { usize::MAX };
            d.deep = (same && opts.depth16).then(|| DeepBase {
                source: Arc::downgrade(&d.source),
                generation,
                n,
                disk: d.disk,
            });
        })
        .map(|(_, i)| i)
    }

    pub fn list_versions(&self, id: DocId) -> AppResult<Vec<versions::FileVersion>> {
        let path = self.file_path(id)?;
        Ok(versions::current()
            .map(|(root, _)| versions::list(&root, &path))
            .unwrap_or_default())
    }

    fn read_version(&self, id: DocId, version: &str) -> AppResult<(PathBuf, Vec<u8>)> {
        let path = self.file_path(id)?;
        let (root, _) =
            versions::current().ok_or_else(|| AppError::NotFound("versões desligadas".into()))?;
        versions::read(&root, &path, version).map_err(|e| match e.kind() {
            ErrorKind::NotFound => AppError::NotFound(format!("versão {version} não existe")),
            _ => e.into(),
        })
    }

    /// Prévia de uma versão no formato de `render_view` (lado maior ≤ `size`).
    pub fn version_preview(&self, id: DocId, version: &str, size: u32) -> AppResult<Vec<u8>> {
        use crate::image::thumb;
        let (file, bytes) = self.read_version(id, version)?;
        let dec = decode::decode_bytes(&file, &bytes)?;
        let img = dec
            .frames
            .first()
            .ok_or_else(|| AppError::Corrupt("versão sem imagem".into()))?;
        let (w, h) = img.dimensions();
        let (tw, th) = thumb::fit_size(w, h, size.max(1), size.max(1));
        let all = super::model::Rect { x: 0, y: 0, w, h };
        Ok(thumb::view_buffer(img, all, tw, th))
    }

    /// Restaurar: a versão vira o conteúdo do documento, **sem gravar**. O documento fica com
    /// alterações; o Salvar (que guarda a atual como versão) é que grava no arquivo.
    pub fn restore_version(&self, id: DocId, version: &str) -> AppResult<DocInfo> {
        let (file, bytes) = self.read_version(id, version)?;
        let dec = decode::decode_bytes(&file, &bytes)?;
        let (_, info) = self.with_doc_mut(id, |d| {
            if d.original.is_none() {
                d.original = Some(d.source.clone());
            }
            d.full_size = dec.frames.first().map_or((0, 0), |f| f.dimensions());
            d.info.writable = Document::can_save(&d.info.path, d.info.format, dec.frames.len());
            d.source = Arc::new(dec);
            d.ops.clear();
            d.redo.clear();
            d.generation += 1;
            d.error = None;
            d.saved_len = usize::MAX;
            d.deep = None;
        })?;
        self.invalidate(id);
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gvi-finder-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn formato_das_etiquetas_igual_ao_kfilemetadata() {
        assert_eq!(parse_tags(b"Trabalho,F\xc3\xa9rias,,Trabalho, x "), s(&["Trabalho", "Férias", "x"]));
        assert!(parse_tags(b"").is_empty());
        assert_eq!(normalize_tags(&s(&[" a ", "", "a", "Pai/Filho"])).unwrap(), s(&["a", "Pai/Filho"]));
        assert!(normalize_tags(&s(&["a,b"])).is_err());
        assert!(normalize_tags(&s(&["a\nb"])).is_err());
        assert!(normalize_tags(&["z".repeat(256)]).is_err());
        let many: Vec<String> = (0..30).map(|i| format!("{i}{}", "y".repeat(200))).collect();
        assert!(normalize_tags(&many).is_err());
    }

    /// Grava e lê `user.xdg.tags` de verdade (se o sistema de arquivos dos testes aceitar).
    #[test]
    fn grava_le_e_remove_etiquetas() {
        let d = tmp("tags");
        let f = d.join("a.png");
        fs::write(&f, b"x").unwrap();
        match write_tags(&f, &s(&["Férias", "Praia"])) {
            Err(AppError::Unsupported(_)) => return eprintln!("sem xattr de usuário aqui"),
            r => assert_eq!(r.unwrap(), s(&["Férias", "Praia"])),
        }
        let raw = fs::File::open(&f).unwrap().get_xattr(TAGS_ATTR).unwrap().unwrap();
        assert_eq!(raw, "Férias,Praia".as_bytes());
        assert_eq!(read_tags(&f).unwrap(), s(&["Férias", "Praia"]));
        write_tags(&f, &[]).unwrap();
        assert_eq!(fs::File::open(&f).unwrap().get_xattr(TAGS_ATTR).unwrap(), None);
        write_tags(&f, &[]).unwrap(); // sem atributo: não é erro
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn bloquear_tira_a_escrita_e_desbloquear_devolve_a_do_dono() {
        let d = tmp("lock");
        let f = d.join("a.png");
        fs::write(&f, b"x").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o664)).unwrap();
        assert!(!is_locked(&f).unwrap());
        set_locked(&f, true).unwrap();
        assert_eq!(fs::metadata(&f).unwrap().mode() & 0o777, 0o444);
        assert!(is_locked(&f).unwrap());
        set_locked(&f, false).unwrap();
        assert_eq!(fs::metadata(&f).unwrap().mode() & 0o777, 0o644);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn sobrescrever_mantem_atributos_de_usuario() {
        let d = tmp("overwrite");
        let f = d.join("a.png");
        fs::write(&f, b"velho").unwrap();
        if write_tags(&f, &s(&["Azul"])).is_err() {
            return eprintln!("sem xattr de usuário aqui");
        }
        overwrite(&f, b"novo").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"novo");
        assert_eq!(read_tags(&f).unwrap(), s(&["Azul"]));
        fs::remove_dir_all(&d).unwrap();
    }
}
