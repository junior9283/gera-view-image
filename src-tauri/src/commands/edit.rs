//! Operações não destrutivas, desfazer e refazer.
use super::blocking;
use crate::{
    doc::{
        model::{ColorAdjust, DocId, DocInfo, Mask, Op, Rect},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::{color, select, thumb},
};
use std::sync::Arc;
use tauri::{AppHandle, State, image::Image, ipc::Response};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
pub async fn apply_op(store: State<'_, DocStore>, id: DocId, op: Op) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.apply_op(id, op)).await
}

#[tauri::command]
pub async fn undo(store: State<'_, DocStore>, id: DocId) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.undo(id)).await
}

#[tauri::command]
pub async fn redo(store: State<'_, DocStore>, id: DocId) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.redo(id)).await
}

/// Alfa Instantâneo: máscara contígua à cor do pixel `(x, y)` (tolerância 0..=1).
#[tauri::command]
pub async fn instant_alpha(
    store: State<'_, DocStore>,
    id: DocId,
    x: u32,
    y: u32,
    tolerance: f32,
) -> AppResult<Mask> {
    let store = store.inner().clone();
    blocking(move || {
        let img = store.render_full(id, 0)?;
        Ok(select::instant_alpha(&img, (x, y), tolerance))
    })
    .await
}

/// Laço magnético: gruda o caminho nas bordas da imagem.
#[tauri::command]
pub async fn snap_lasso(
    store: State<'_, DocStore>,
    id: DocId,
    points: Vec<(f32, f32)>,
) -> AppResult<Vec<(f32, f32)>> {
    let store = store.inner().clone();
    blocking(move || {
        let img = store.render_full(id, 0)?;
        Ok(select::snap_lasso(&img, &points))
    })
    .await
}

/// Coloca a região selecionada (ou a imagem toda) na área de transferência como imagem.
#[tauri::command]
pub async fn copy_region(
    app: AppHandle,
    store: State<'_, DocStore>,
    id: DocId,
    mask: Option<Mask>,
    frame: Option<u32>,
) -> AppResult<()> {
    let store = store.inner().clone();
    let frame = frame.unwrap_or(0);
    let region =
        blocking(move || super::paste::copied_region(&store, id, frame, mask.as_ref(), None))
            .await?;
    let (w, h) = region.dimensions();
    app.clipboard()
        .write_image(&Image::new_owned(region.into_raw(), w, h))
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Teto de pixels de uma prévia de ajuste (o visor já pede menos; isto limita qualquer pedido).
pub const PREVIEW_MAX_PIXELS: u64 = 8_000_000;

/// Reduz `w`x`h` (na proporção) para caber em `cap` pixels.
pub fn cap_size(w: u32, h: u32, cap: u64) -> (u32, u32) {
    let px = u64::from(w) * u64::from(h);
    if px <= cap {
        return (w, h);
    }
    let k = (cap as f64 / px as f64).sqrt();
    let side = |v: u32| ((f64::from(v) * k).floor() as u32).max(1);
    let (cw, ch) = (side(w), side(h));
    // Um lado arredondado para 1 px pode deixar o outro além do teto.
    let fit = |a: u32, b: u32| a.min(u32::try_from(cap / u64::from(b)).unwrap_or(u32::MAX)).max(1);
    (fit(cw, ch), fit(ch, cw))
}

/// Prévia de um ajuste de cor em resolução de tela; não altera o documento. `frame` e `region`:
/// só o trecho visível da página mostrada.
#[tauri::command]
pub async fn preview_adjust(
    store: State<'_, DocStore>,
    id: DocId,
    adjust: ColorAdjust,
    max_w: u32,
    max_h: u32,
    frame: Option<u32>,
    region: Option<Rect>,
) -> AppResult<Response> {
    let store = store.inner().clone();
    blocking(move || {
        let (w, h) = cap_size(max_w, max_h, PREVIEW_MAX_PIXELS);
        let mut buf = store.preview_region(id, frame.unwrap_or(0), w, h, region)?.to_vec();
        color::adjust_view_buffer(&mut buf, &adjust);
        store.to_screen(id, &mut buf[thumb::HEADER_LEN..]);
        Ok(buf)
    })
    .await
    .map(Response::new)
}

/// Lado máximo da amostra usada para histograma e níveis automáticos.
const SAMPLE: u32 = 1024;

/// Amostra reduzida (compartilha o cache de `preview_base`); o RGBA começa em
/// `thumb::HEADER_LEN`.
fn sample(store: &DocStore, id: DocId) -> AppResult<Arc<Vec<u8>>> {
    let buf = store.preview_base(id, SAMPLE, SAMPLE)?;
    thumb::view_buffer_size(&buf).ok_or_else(|| AppError::Io("buffer de prévia inválido".into()))?;
    Ok(buf)
}

#[tauri::command]
pub async fn histogram(store: State<'_, DocStore>, id: DocId) -> AppResult<color::Histogram> {
    let store = store.inner().clone();
    blocking(move || Ok(color::histogram(&sample(&store, id)?[thumb::HEADER_LEN..]))).await
}

#[tauri::command]
pub async fn auto_levels(store: State<'_, DocStore>, id: DocId) -> AppResult<ColorAdjust> {
    let store = store.inner().clone();
    blocking(move || Ok(color::auto_levels(&sample(&store, id)?[thumb::HEADER_LEN..]))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tamanho_da_previa_respeita_o_teto_de_pixels() {
        assert_eq!(cap_size(800, 600, PREVIEW_MAX_PIXELS), (800, 600));
        for (w, h) in [(8000, 4000), (u32::MAX, u32::MAX), (u32::MAX, 1), (1, u32::MAX)] {
            let (cw, ch) = cap_size(w, h, PREVIEW_MAX_PIXELS);
            assert!(cw >= 1 && ch >= 1, "{cw}x{ch}");
            assert!(u64::from(cw) * u64::from(ch) <= PREVIEW_MAX_PIXELS, "{cw}x{ch}");
        }
        // Mantém a proporção.
        let (w, h) = cap_size(8000, 4000, PREVIEW_MAX_PIXELS);
        assert!(w.abs_diff(h * 2) <= 2, "{w}x{h}");
        assert_eq!(cap_size(0, 0, PREVIEW_MAX_PIXELS), (0, 0));
    }
}
