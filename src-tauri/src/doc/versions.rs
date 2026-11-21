//! Versões locais ("Reverter Para ▸ Procurar Todas as Versões…").
//!
//! Antes de cada Salvar que sobrescreve o arquivo, o conteúdo atual do disco é copiado para
//! `<raiz>/<md5 do caminho>/<ms>-<seq>.<ext>` (a raiz é `~/.local/share/gera-view-image/versions`,
//! configurada pelo `lib.rs`; sem configuração, nada é guardado, como nos testes).
//!
//! Segurança: as pastas são privadas (0700, do próprio usuário, nunca symlink) e os arquivos
//! nascem 0600 com `O_EXCL`/`O_NOFOLLOW`. Nada é lido nem apagado através de symlink: a
//! listagem e a poda olham só arquivos regulares (`symlink_metadata`). O espaço total de todas
//! as versões fica abaixo do limite (`prefs.versionsMaxMb`): as mais antigas saem primeiro.
use serde::Serialize;
use std::{
    fs, io,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        RwLock,
        atomic::{AtomicU32, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// Limite padrão (igual ao `versionsMaxMb` padrão da interface).
pub const DEFAULT_MAX_BYTES: u64 = 500 << 20;
/// Arquivo, dentro da pasta de cada documento, com o caminho original (diagnóstico).
const SOURCE_FILE: &str = "source";

/// Versão guardada de um arquivo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub id: String,
    /// Data e hora em ISO 8601 (UTC).
    pub saved_at: String,
    pub size: u64,
}

struct Config {
    root: Option<PathBuf>,
    max_bytes: u64,
}

static CONFIG: RwLock<Config> = RwLock::new(Config {
    root: None,
    max_bytes: DEFAULT_MAX_BYTES,
});

/// Liga as versões, guardadas em `root` (chamado uma vez na inicialização do app).
pub fn configure(root: PathBuf) {
    CONFIG.write().unwrap_or_else(|e| e.into_inner()).root = Some(root);
}

/// Limite de espaço de todas as versões juntas; `0` desliga as versões novas.
pub fn set_max_bytes(max: u64) {
    CONFIG.write().unwrap_or_else(|e| e.into_inner()).max_bytes = max;
}

/// `(raiz, limite)`, se as versões estiverem ligadas.
pub fn current() -> Option<(PathBuf, u64)> {
    let c = CONFIG.read().unwrap_or_else(|e| e.into_inner());
    c.root.clone().map(|r| (r, c.max_bytes))
}

fn other(msg: impl Into<String>) -> io::Error {
    io::Error::other(msg.into())
}

/// Cria (se faltar) e confere uma pasta privada: diretório de verdade (não symlink), do próprio
/// usuário e sem acesso de grupo/outros (corrige o modo se precisar).
fn private_dir(p: &Path) -> io::Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(p) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    check_private(p)?;
    let m = fs::symlink_metadata(p)?;
    if m.mode() & 0o077 != 0 {
        fs::set_permissions(p, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn check_private(p: &Path) -> io::Result<()> {
    let m = fs::symlink_metadata(p)?;
    // SAFETY: `geteuid` não tem pré-condições.
    let uid = unsafe { libc::geteuid() };
    if !m.is_dir() || m.uid() != uid {
        return Err(other(format!("{} não é uma pasta privada do app", p.display())));
    }
    Ok(())
}

/// Nome da pasta das versões de `path`: MD5 do caminho absoluto canônico.
fn key(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    format!("{:x}", md5::compute(canon.as_os_str().as_bytes()))
}

/// Pasta das versões de `path`; com `create`, cria a raiz e a pasta (privadas).
fn doc_dir(root: &Path, path: &Path, create: bool) -> io::Result<PathBuf> {
    let dir = root.join(key(path));
    if create {
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent)?;
        }
        private_dir(root)?;
        private_dir(&dir)?;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(dir.join(SOURCE_FILE))?;
        f.write_all(path.as_os_str().as_encoded_bytes())?;
    } else {
        check_private(root)?;
        check_private(&dir)?;
    }
    Ok(dir)
}

/// Id de versão válido: `<ms>-<seq>.<ext>` (só dígitos e extensão alfanumérica curta).
pub fn valid_id(id: &str) -> bool {
    let Some((stem, ext)) = id.split_once('.') else {
        return false;
    };
    let Some((ms, seq)) = stem.split_once('-') else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit());
    digits(ms)
        && digits(seq)
        && (1..=10).contains(&ext.len())
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

struct Entry {
    path: PathBuf,
    id: String,
    ms: u64,
    size: u64,
}

/// Versões da pasta, da mais nova para a mais antiga (só arquivos regulares com id válido).
fn entries(dir: &Path) -> Vec<Entry> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Entry> = rd
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().into_string().ok()?;
            if !valid_id(&id) {
                return None;
            }
            let m = e.metadata().ok()?; // `DirEntry::metadata` não segue symlinks
            if !m.file_type().is_file() {
                return None;
            }
            let ms = id.split('-').next()?.parse().ok()?;
            Some(Entry {
                path: e.path(),
                id,
                ms,
                size: m.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| b.id.cmp(&a.id)));
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Extensão (minúscula, alfanumérica) para o nome da versão; o decodificador usa o conteúdo.
fn ext_of(path: &Path) -> String {
    let ext: String = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(10)
        .collect();
    if ext.is_empty() { "bin".into() } else { ext }
}

/// Guarda o conteúdo atual de `path` como versão. `None` se não guardou: versões desligadas
/// (`max == 0`), arquivo ainda inexistente, maior que o limite, ou igual à versão mais nova.
pub fn snapshot(root: &Path, path: &Path, max: u64) -> io::Result<Option<String>> {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    if max == 0 {
        return Ok(None);
    }
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.is_file() || meta.len() > max {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let dir = doc_dir(root, path, true)?;
    if let Some(last) = entries(&dir).first()
        && last.size == bytes.len() as u64
        && fs::read(&last.path).is_ok_and(|b| b == bytes)
    {
        return Ok(None);
    }
    let id = format!(
        "{:013}-{}.{}",
        now_ms(),
        SEQ.fetch_add(1, Ordering::Relaxed),
        ext_of(path)
    );
    let part = dir.join(format!(".{id}.part"));
    let written = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&part)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        fs::rename(&part, dir.join(&id))
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    prune(root, max);
    Ok(Some(id))
}

/// Apaga as versões mais antigas (de todos os arquivos) até o total caber em `max`, e remove
/// as pastas que ficaram sem versões. Só apaga arquivos regulares dentro das pastas do app.
pub fn prune(root: &Path, max: u64) {
    if check_private(root).is_err() {
        return;
    }
    let Ok(rd) = fs::read_dir(root) else { return };
    let dirs: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.metadata().is_ok_and(|m| m.is_dir()))
        .map(|e| e.path())
        .collect();
    let mut all: Vec<Entry> = dirs.iter().flat_map(|d| entries(d)).collect();
    let mut total: u64 = all.iter().map(|e| e.size).sum();
    all.sort_by_key(|e| e.ms);
    for e in &all {
        if total <= max {
            break;
        }
        if fs::remove_file(&e.path).is_ok() {
            total -= e.size;
        }
    }
    for d in dirs {
        if entries(&d).is_empty() {
            let _ = fs::remove_file(d.join(SOURCE_FILE));
            let _ = fs::remove_dir(&d);
        }
    }
}

/// Versões guardadas de `path`, da mais nova para a mais antiga.
pub fn list(root: &Path, path: &Path) -> Vec<FileVersion> {
    let Ok(dir) = doc_dir(root, path, false) else {
        return Vec::new();
    };
    entries(&dir)
        .into_iter()
        .map(|e| FileVersion {
            saved_at: iso_utc(e.ms),
            id: e.id,
            size: e.size,
        })
        .collect()
}

/// Caminho e bytes da versão `id` de `path` (sem seguir symlink).
pub fn read(root: &Path, path: &Path, id: &str) -> io::Result<(PathBuf, Vec<u8>)> {
    use std::io::Read;
    if !valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "versão inválida"));
    }
    let file = doc_dir(root, path, false)?.join(id);
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&file)?;
    if !f.metadata()?.is_file() {
        return Err(other("versão não é um arquivo"));
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    Ok((file, bytes))
}

/// Milissegundos desde 1970 → `AAAA-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Algoritmo civil_from_days (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gvi-versoes-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn data_iso_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(iso_utc(1_795_000_000_000), "2026-11-18T11:06:40.000Z");
    }

    #[test]
    fn ids_validos() {
        assert!(valid_id("1795000000000-3.jpg"));
        for bad in ["../x.jpg", "1-2", "a-1.jpg", "1-2.j/g", "1-2.", "source", ".1-2.jpg.part", "1-2.jpg.png"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn guarda_lista_e_le_versoes_em_pasta_privada() {
        let d = tmp("guarda");
        let root = d.join("data/gera-view-image/versions");
        let img = d.join("foto.JPG");
        fs::write(&img, b"v1").unwrap();
        let id1 = snapshot(&root, &img, 1 << 20).unwrap().unwrap();
        assert!(id1.ends_with(".jpg"));
        // Mesmo conteúdo: não duplica.
        assert_eq!(snapshot(&root, &img, 1 << 20).unwrap(), None);
        fs::write(&img, b"v2-maior").unwrap();
        let id2 = snapshot(&root, &img, 1 << 20).unwrap().unwrap();

        let list = list(&root, &img);
        assert_eq!(list.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), [&*id2, &*id1]);
        assert_eq!(list[0].size, 8);
        assert_eq!(read(&root, &img, &id1).unwrap().1, b"v1");

        let mode = |p: &Path| fs::metadata(p).unwrap().mode() & 0o777;
        assert_eq!(mode(&root), 0o700);
        let dir = root.join(key(&img));
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(&id1)), 0o600);
        assert!(read(&root, &img, "../../foto.JPG").is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn desligado_ou_maior_que_o_limite_nao_guarda() {
        let d = tmp("limite");
        let root = d.join("versions");
        let img = d.join("a.png");
        fs::write(&img, vec![0u8; 100]).unwrap();
        assert_eq!(snapshot(&root, &img, 0).unwrap(), None);
        assert_eq!(snapshot(&root, &img, 99).unwrap(), None);
        assert_eq!(snapshot(&root, &d.join("nao-existe.png"), 1000).unwrap(), None);
        assert!(!root.exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn poda_as_mais_antigas_de_todos_os_arquivos() {
        let d = tmp("poda");
        let root = d.join("versions");
        let (a, b) = (d.join("a.png"), d.join("b.png"));
        fs::write(&a, vec![1u8; 40]).unwrap();
        let a1 = snapshot(&root, &a, 100).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        fs::write(&b, vec![2u8; 40]).unwrap();
        let b1 = snapshot(&root, &b, 100).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        fs::write(&a, vec![3u8; 40]).unwrap();
        let a2 = snapshot(&root, &a, 100).unwrap().unwrap();
        // 120 bytes > 100: sai a mais antiga (a1), de qualquer arquivo.
        let ids = |p: &Path| list(&root, p).into_iter().map(|v| v.id).collect::<Vec<_>>();
        assert_eq!(ids(&a), [a2.clone()]);
        assert_eq!(ids(&b), [b1]);
        assert_ne!(a1, a2);
        // Limite menor: a pasta de `b` fica vazia e é removida.
        fs::write(&a, vec![4u8; 40]).unwrap();
        snapshot(&root, &a, 50).unwrap();
        assert!(ids(&b).is_empty());
        assert!(!root.join(key(&b)).exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn nao_segue_symlink_na_raiz_nem_nas_versoes() {
        let d = tmp("symlink");
        let alvo = d.join("alvo");
        fs::create_dir_all(&alvo).unwrap();
        let root = d.join("versions");
        symlink(&alvo, &root).unwrap();
        let img = d.join("a.png");
        fs::write(&img, b"x").unwrap();
        assert!(snapshot(&root, &img, 1000).is_err(), "raiz symlink é recusada");
        assert_eq!(fs::read_dir(&alvo).unwrap().count(), 0);
        fs::remove_file(&root).unwrap();

        // Versão trocada por symlink: nem listada, nem lida, nem apagada através dele.
        let id = snapshot(&root, &img, 1000).unwrap().unwrap();
        let dir = root.join(key(&img));
        let segredo = d.join("segredo.txt");
        fs::write(&segredo, b"segredo").unwrap();
        fs::remove_file(dir.join(&id)).unwrap();
        symlink(&segredo, dir.join(&id)).unwrap();
        assert!(list(&root, &img).is_empty());
        assert!(read(&root, &img, &id).is_err());
        prune(&root, 0);
        assert_eq!(fs::read(&segredo).unwrap(), b"segredo");
        fs::remove_dir_all(&d).unwrap();
    }
}
