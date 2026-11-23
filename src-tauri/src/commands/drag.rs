//! Arrastar miniaturas para fora da janela: drag-source nativo do GTK3
//! (`gtk_drag_begin_with_coordinates` na janela, alvo `text/uri-list`), que funciona em X11 e
//! em Wayland sem nada novo no NEEDED (o GTK já está lá). Documento com alterações não salvas
//! ou sem arquivo vai como PNG temporário numa pasta privada (0700) apagada ao sair.
use super::blocking;
use crate::{
    doc::{file::render_png, model::DocId, store::DocStore},
    error::{AppError, AppResult},
};
use serde::Deserialize;
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};

/// Um item do arraste: `export` = gerar o PNG temporário em vez de usar o arquivo.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragSource {
    pub id: DocId,
    pub export: bool,
}

/// Pasta dos temporários deste processo (`<cache>/drag/<pid>`).
pub struct DragTemp(pub PathBuf);

const ICON_PX: u32 = 96;

/// Cria `dir` (e os pais) só para o dono e corrige a permissão se ele já existia. A pasta é
/// aberta sem seguir link (`O_NOFOLLOW`) e corrigida pelo descritor: um link plantado no lugar
/// dela é erro, e a permissão do alvo nunca muda.
pub(crate) fn private_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(dir)?
        .set_permissions(fs::Permissions::from_mode(0o700))
}

/// Grava o PNG em `<base>/<id>/<nome>.png` (pastas 0700, arquivo 0600). Cada documento tem a
/// sua subpasta: nomes iguais não colidem e o arquivo solto leva o nome do documento.
pub fn write_temp(base: &Path, id: DocId, name: &str, png: &[u8]) -> io::Result<PathBuf> {
    private_dir(base)?;
    let dir = base.join(id.0.to_string());
    private_dir(&dir)?;
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("imagem");
    let path = dir.join(format!("{stem}.png"));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)?;
    f.set_permissions(fs::Permissions::from_mode(0o600))?;
    f.write_all(png)?;
    Ok(path)
}

/// Apaga os temporários deste processo (ao sair).
pub fn cleanup(base: &Path) {
    match fs::remove_dir_all(base) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => eprintln!("temporários do arraste: {e}"),
        _ => {}
    }
}

/// Pasta de temporários deste processo (`<root>/<pid>`), sem restos: apaga as de processos que já
/// terminaram e também a do próprio pid, herdada de um processo antigo que caiu com o mesmo número.
pub fn fresh_temp(root: &Path, pid: u32, alive: impl Fn(u32) -> bool) -> PathBuf {
    sweep_stale(root, alive);
    let dir = root.join(pid.to_string());
    cleanup(&dir);
    dir
}

/// Apaga as pastas `<root>/<pid>` de processos que já terminaram (o app caiu sem limpar).
pub fn sweep_stale(root: &Path, alive: impl Fn(u32) -> bool) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for e in entries.flatten() {
        if let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok())
            && !alive(pid)
        {
            cleanup(&e.path());
        }
    }
}

pub fn pid_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

/// Caminho de cada item: o arquivo do documento, ou o PNG temporário quando pedido, quando o
/// documento não tem arquivo ou quando o arquivo sumiu do disco.
pub(super) fn resolve(store: &DocStore, base: &Path, items: &[DragSource]) -> AppResult<Vec<PathBuf>> {
    items
        .iter()
        .map(|it| {
            let info = store.info(it.id)?;
            let file = Path::new(&info.path);
            if !it.export && !info.path.is_empty() && file.is_file() {
                return Ok(file.to_path_buf());
            }
            let png = render_png(store, it.id)?;
            Ok(write_temp(base, it.id, &info.name, &png)?)
        })
        .collect()
}

/// URIs `file://` dos caminhos (acentos e espaços escapados).
pub(super) fn file_uris(paths: &[PathBuf]) -> AppResult<Vec<String>> {
    paths
        .iter()
        .map(|p| {
            gtk::glib::filename_to_uri(p, None)
                .map(|u| u.to_string())
                .map_err(|e| AppError::Io(e.to_string()))
        })
        .collect()
}

/// Começa o arraste nativo com os documentos pedidos e só responde quando ele termina (a
/// interface ignora o próprio arraste se ele for solto de volta na janela).
#[tauri::command]
pub async fn start_drag(
    window: WebviewWindow,
    store: State<'_, DocStore>,
    temp: State<'_, DragTemp>,
    items: Vec<DragSource>,
) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let store = store.inner().clone();
    let base = temp.0.clone();
    let (paths, icon) = blocking(move || {
        let paths = resolve(&store, &base, &items)?;
        // Ícone: miniatura do primeiro (sem ela, o GTK usa o ícone padrão).
        let icon = store.thumbnail(items[0].id, 0, ICON_PX).ok();
        Ok((paths, icon))
    })
    .await?;
    let uris = file_uris(&paths)?;

    let (tx, mut rx) = tauri::async_runtime::channel::<AppResult<()>>(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let gtk_win = match win.gtk_window() {
                Ok(w) => w,
                Err(e) => {
                    let _ = tx.try_send(Err(AppError::Io(e.to_string())));
                    return;
                }
            };
            let fail = tx.clone();
            if let Err(e) = native::begin(&gtk_win, uris, icon, move || {
                let _ = tx.try_send(Ok(()));
            }) {
                let _ = fail.try_send(Err(e));
            }
        })
        .map_err(|e| AppError::Io(e.to_string()))?;
    rx.recv().await.unwrap_or(Ok(()))
}

mod native {
    use crate::error::{AppError, AppResult};
    use gtk::{
        gdk, gdk_pixbuf,
        glib::{self, ObjectExt},
        prelude::*,
    };
    use std::{cell::RefCell, rc::Rc};

    /// Miniatura do IPC (`[w u32][h u32][RGBA…]`) em pixbuf.
    fn pixbuf(buf: &[u8]) -> Option<gdk_pixbuf::Pixbuf> {
        let w = u32::from_le_bytes(buf.get(0..4)?.try_into().ok()?) as i32;
        let h = u32::from_le_bytes(buf.get(4..8)?.try_into().ok()?) as i32;
        let px = buf.get(8..)?;
        if w <= 0 || h <= 0 || px.len() != (w * h * 4) as usize {
            return None;
        }
        Some(gdk_pixbuf::Pixbuf::from_bytes(
            &glib::Bytes::from(px),
            gdk_pixbuf::Colorspace::Rgb,
            true,
            8,
            w,
            h,
            w * 4,
        ))
    }

    /// Botão 1 ainda apertado? Se o usuário soltou antes do PNG ficar pronto, o arraste não
    /// começa (no X11 ele ficaria preso ao ponteiro até o próximo clique).
    fn button_held(win: &gtk::ApplicationWindow) -> bool {
        let Some(gdk_win) = win.window() else { return false };
        let Some(pointer) = win.display().default_seat().and_then(|s| s.pointer()) else {
            return false;
        };
        let (_, _, _, mask) = gdk_win.device_position(&pointer);
        mask.contains(gdk::ModifierType::BUTTON1_MASK)
    }

    pub fn begin(
        win: &gtk::ApplicationWindow,
        uris: Vec<String>,
        icon: Option<Vec<u8>>,
        done: impl FnOnce() + 'static,
    ) -> AppResult<()> {
        if !button_held(win) {
            done();
            return Ok(());
        }
        let targets = gtk::TargetList::new(&[]);
        targets.add_uri_targets(0);
        let data = win.connect_drag_data_get(move |_, _, sel, _, _| {
            let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
            sel.set_uris(&refs);
        });
        let Some(ctx) = win.drag_begin_with_coordinates(&targets, gdk::DragAction::COPY, 1, None, -1, -1)
        else {
            win.disconnect(data);
            return Err(AppError::Io("o GTK recusou o arraste".into()));
        };
        if let Some(p) = icon.as_deref().and_then(pixbuf) {
            ctx.drag_set_icon_pixbuf(&p, p.width() / 2, p.height() / 2);
        }
        // `drag-end` vem sempre (soltou, cancelou ou falhou): desliga os sinais e avisa.
        let state = Rc::new(RefCell::new(Some((data, done))));
        let end = Rc::new(RefCell::new(None));
        let end2 = end.clone();
        *end.borrow_mut() = Some(win.connect_drag_end(move |w, _| {
            if let Some((data, done)) = state.borrow_mut().take() {
                w.disconnect(data);
                if let Some(id) = end2.borrow_mut().take() {
                    w.disconnect(id);
                }
                done();
            }
        }));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gvi-drag-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn pasta_do_proprio_pid_herdada_comeca_vazia() {
        let root = scratch("reuso");
        let velha = root.join("4242");
        fs::create_dir_all(&velha).unwrap();
        fs::write(velha.join("scan-0.png"), b"resto").unwrap();
        let dir = fresh_temp(&root, 4242, |_| true);
        assert_eq!(dir, velha);
        assert!(!velha.join("scan-0.png").exists(), "resto de um processo antigo com o mesmo pid");
        cleanup(&root);
    }

    #[test]
    fn pasta_privada_nao_segue_link_plantado() {
        let root = scratch("link");
        let alvo = root.join("alvo");
        fs::create_dir_all(&alvo).unwrap();
        fs::set_permissions(&alvo, fs::Permissions::from_mode(0o755)).unwrap();
        let link = root.join("scan");
        std::os::unix::fs::symlink(&alvo, &link).unwrap();
        assert!(private_dir(&link).is_err());
        assert_eq!(mode(&alvo), 0o755, "a permissão do alvo não muda");
        // Um arquivo no lugar da pasta também é recusado.
        fs::write(root.join("arquivo"), b"x").unwrap();
        assert!(private_dir(&root.join("arquivo")).is_err());
        cleanup(&root);
    }

    #[test]
    fn temporario_fica_em_pasta_privada_com_o_nome_do_documento() {
        let root = scratch("modo");
        let base = root.join("drag").join("123");
        let p = write_temp(&base, DocId(7), "foto.jpg", b"png").unwrap();
        assert_eq!(p, base.join("7").join("foto.png"));
        assert_eq!(fs::read(&p).unwrap(), b"png");
        assert_eq!(mode(&base), 0o700);
        assert_eq!(mode(&base.join("7")), 0o700);
        assert_eq!(mode(&p), 0o600);
        cleanup(&root);
    }

    #[test]
    fn corrige_permissoes_de_pasta_e_arquivo_que_ja_existiam() {
        let base = scratch("existente");
        fs::create_dir_all(base.join("1")).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(base.join("1"), fs::Permissions::from_mode(0o777)).unwrap();
        let old = base.join("1").join("Sem título.png");
        fs::write(&old, b"antigo-e-maior").unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o644)).unwrap();

        let p = write_temp(&base, DocId(1), "Sem título", b"novo").unwrap();
        assert_eq!(p, old);
        assert_eq!(fs::read(&p).unwrap(), b"novo");
        assert_eq!(mode(&base), 0o700);
        assert_eq!(mode(&base.join("1")), 0o700);
        assert_eq!(mode(&p), 0o600);
        cleanup(&base);
    }

    #[test]
    fn nome_vazio_vira_imagem_png() {
        let base = scratch("vazio");
        let p = write_temp(&base, DocId(2), "", b"x").unwrap();
        assert_eq!(p.file_name().unwrap(), "imagem.png");
        cleanup(&base);
    }

    #[test]
    fn limpeza_apaga_a_pasta_do_processo_e_as_de_processos_mortos() {
        let root = scratch("limpeza");
        for pid in ["10", "20"] {
            write_temp(&root.join(pid), DocId(1), "a.png", b"x").unwrap();
        }
        fs::create_dir_all(root.join("outra")).unwrap();
        sweep_stale(&root, |pid| pid == 20);
        assert!(!root.join("10").exists());
        assert!(root.join("20").exists());
        assert!(root.join("outra").exists(), "só pastas com nome de pid");
        cleanup(&root.join("20"));
        assert!(!root.join("20").exists());
        cleanup(&root.join("20")); // já apagada: não falha
        cleanup(&root);
    }

    #[test]
    fn processo_atual_esta_vivo() {
        assert!(pid_alive(std::process::id()));
    }
}
