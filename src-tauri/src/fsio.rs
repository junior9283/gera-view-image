//! Leitura de arquivos que o usuário escolheu. Um FIFO ou dispositivo no lugar de um arquivo
//! (`mkfifo foto.png`) não pode travar o app esperando um escritor: tudo abre com `O_NONBLOCK`
//! e só segue se for arquivo regular (`ErrorKind::Unsupported`, que vira o código `unsupported`).
use std::{
    fs::File,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

/// Abre `path` para leitura; recusa o que não é arquivo regular. `extra`: outras flags do `open`
/// (por exemplo `O_NOFOLLOW`).
pub fn open_regular_with(path: &Path, extra: i32) -> io::Result<File> {
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC | extra)
        .open(path)?;
    if !f.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("{} não é um arquivo regular", path.display()),
        ));
    }
    Ok(f)
}

pub fn open_regular(path: &Path) -> io::Result<File> {
    open_regular_with(path, 0)
}

/// O arquivo inteiro (`std::fs::read` só para arquivo regular).
pub fn read_regular(path: &Path) -> io::Result<Vec<u8>> {
    let mut f = open_regular(path)?;
    let mut bytes = Vec::with_capacity(usize::try_from(f.metadata()?.len()).unwrap_or(0));
    f.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Até `n` bytes do começo do arquivo.
pub fn read_head(path: &Path, n: u64) -> io::Result<Vec<u8>> {
    let mut head = Vec::new();
    open_regular(path)?.take(n).read_to_end(&mut head)?;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fifo_e_dispositivo_sao_recusados_sem_travar() {
        let dir = crate::image::test_util::TempDir::new("fsio");
        let fifo = dir.path().join("pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: caminho C válido e terminado em NUL.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        for p in [fifo.as_path(), Path::new("/dev/null")] {
            for e in [open_regular(p).unwrap_err(), read_regular(p).unwrap_err(), read_head(p, 8).unwrap_err()] {
                assert_eq!(e.kind(), io::ErrorKind::Unsupported, "{p:?}");
            }
        }
        let ok = dir.path().join("a");
        std::fs::write(&ok, b"abcdef").unwrap();
        assert_eq!(read_regular(&ok).unwrap(), b"abcdef");
        assert_eq!(read_head(&ok, 3).unwrap(), b"abc");
    }
}
