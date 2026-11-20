//! Provisório (Tarefa 0): lê `argv[1]` e serve a imagem no formato de `render_view`
//! (`u32 LE w`, `u32 LE h`, RGBA). Substituído pelo módulo `doc` na Tarefa 4.
use image::{imageops::FilterType, DynamicImage};
use std::{path::PathBuf, sync::Mutex, time::Instant};
use tauri::{ipc::Response, State};

pub struct Provisional {
    pub t0: Instant,
    pub path: Option<PathBuf>,
    image: Mutex<Option<DynamicImage>>,
}

impl Provisional {
    pub fn new(t0: Instant, path: Option<PathBuf>) -> Self {
        Self { t0, path, image: Mutex::new(None) }
    }

    fn log(&self, evento: &str) {
        eprintln!("[gvi {:>6} ms] {evento}", self.t0.elapsed().as_millis());
    }
}

/// Codifica a imagem ajustada a `max_w` x `max_h` (sem ampliar) no formato de `render_view`.
pub fn encode_view(img: &DynamicImage, max_w: u32, max_h: u32) -> Vec<u8> {
    let rgba = if img.width() > max_w || img.height() > max_h {
        img.resize(max_w, max_h, FilterType::Triangle).to_rgba8()
    } else {
        img.to_rgba8()
    };
    let mut out = Vec::with_capacity(8 + rgba.len());
    out.extend_from_slice(&rgba.width().to_le_bytes());
    out.extend_from_slice(&rgba.height().to_le_bytes());
    out.extend_from_slice(rgba.as_raw());
    out
}

#[tauri::command]
pub fn render_view(
    state: State<'_, Provisional>,
    max_w: u32,
    max_h: u32,
) -> Result<Response, String> {
    let mut guard = state.image.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let path = state.path.as_ref().ok_or("nenhum arquivo informado")?;
        *guard = Some(image::open(path).map_err(|e| e.to_string())?);
        state.log("decodificado");
    }
    let bytes = encode_view(guard.as_ref().expect("preenchido acima"), max_w, max_h);
    state.log("buffer pronto");
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn mark_shown(state: State<'_, Provisional>) {
    state.log("imagem exibida");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cabecalho_e_rgba_ajustados_a_janela() {
        let img = DynamicImage::new_rgba8(400, 200);
        let b = encode_view(&img, 100, 100);
        let w = u32::from_le_bytes(b[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(b[4..8].try_into().unwrap());
        assert_eq!((w, h), (100, 50));
        assert_eq!(b.len(), 8 + (w * h * 4) as usize);
    }

    #[test]
    fn nao_amplia_imagem_menor() {
        let img = DynamicImage::new_rgba8(40, 20);
        let b = encode_view(&img, 100, 100);
        assert_eq!(u32::from_le_bytes(b[0..4].try_into().unwrap()), 40);
    }
}
