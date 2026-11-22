//! Lote 2 (Seleção e área de transferência): imagens que viram camada colada (área de
//! transferência ou arquivo solto sobre a imagem) e Copiar com as anotações achatadas.
use super::blocking;
use crate::{
    doc::{
        model::{DocId, Mask, Op},
        store::DocStore,
    },
    error::{AppError, AppResult},
    image::{decode, icc, ops, select},
};
use ::image::{
    ExtendedColorType, ImageEncoder, RgbaImage,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use std::path::Path;
use tauri::{AppHandle, State, image::Image, ipc::Response};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// PNG rápido (a camada colada vira `data:` URL na interface).
fn png_bytes(img: &RgbaImage) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(AppError::from)?;
    Ok(out)
}

/// Primeiro quadro do arquivo, em PNG (outros formatos e animações também viram camada).
fn file_png(path: &Path) -> AppResult<Vec<u8>> {
    let mut decoded = decode::decode(path)?;
    let icc = decoded.icc.take();
    let first = decoded.frames.first_mut().ok_or(AppError::EmptySelection)?;
    // A camada é desenhada sobre a prévia e achatada como cor de tela (Lote 1).
    icc::to_display(first, icc.as_deref());
    png_bytes(first)
}

/// Região de `img` com as anotações (`png`, no tamanho da imagem) compostas por cima.
fn flattened_region(img: &RgbaImage, mask: Option<&Mask>, png: Option<Vec<u8>>) -> Option<RgbaImage> {
    let flat = png.map(|png| ops::apply(img, &Op::Composite { png }));
    select::extract_region(flat.as_ref().unwrap_or(img), mask)
}

/// PNG da imagem na área de transferência (bytes crus), para virar anotação `image`.
#[tauri::command]
pub async fn clipboard_image(app: AppHandle) -> AppResult<Response> {
    let img = app.clipboard().read_image().map_err(|_| AppError::ClipboardEmpty)?;
    let rgba = RgbaImage::from_raw(img.width(), img.height(), img.rgba().to_vec())
        .ok_or(AppError::ClipboardEmpty)?;
    blocking(move || png_bytes(&rgba)).await.map(Response::new)
}

/// PNG do arquivo solto sobre a imagem aberta (vira camada colada, como no Pré-Visualização).
#[tauri::command]
pub async fn image_file_png(path: String) -> AppResult<Response> {
    blocking(move || file_png(Path::new(&path))).await.map(Response::new)
}

/// Copiar com anotações: a região (ou a imagem inteira) com o PNG das anotações por cima.
#[tauri::command]
pub async fn copy_image(
    app: AppHandle,
    store: State<'_, DocStore>,
    id: DocId,
    mask: Option<Mask>,
    png: Option<Vec<u8>>,
) -> AppResult<()> {
    let store = store.inner().clone();
    let region = blocking(move || {
        let img = store.render_full(id, 0)?;
        let png = png.map(|png| store.png_from_display(id, png));
        flattened_region(&img, mask.as_ref(), png).ok_or(AppError::EmptySelection)
    })
    .await?;
    let (w, h) = region.dimensions();
    app.clipboard()
        .write_image(&Image::new_owned(region.into_raw(), w, h))
        .map_err(|e| AppError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::model::Rect;
    use ::image::Rgba;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    fn decode_png(b: &[u8]) -> RgbaImage {
        ::image::load_from_memory_with_format(b, ::image::ImageFormat::Png)
            .unwrap()
            .into_rgba8()
    }

    #[test]
    fn png_bytes_preserva_pixels_e_alfa() {
        let mut img = solid(3, 2, [10, 20, 30, 255]);
        img.put_pixel(1, 1, Rgba([0, 0, 0, 0]));
        assert_eq!(decode_png(&png_bytes(&img).unwrap()), img);
    }

    #[test]
    fn file_png_devolve_o_primeiro_quadro() {
        let dir = std::env::temp_dir().join(format!("gvi-paste-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.png");
        let img = solid(4, 3, [200, 100, 50, 255]);
        img.save(&path).unwrap();
        let got = file_png(&path);
        let missing = file_png(&dir.join("nao-existe.png"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(decode_png(&got.unwrap()), img);
        assert!(missing.is_err());
    }

    /// A camada de um arquivo P3 entra em cores de tela (sRGB), como as anotações.
    #[test]
    fn file_png_de_arquivo_p3_vira_cor_de_tela() {
        use crate::image::encode::{ExportFormat, ExportOptions, MetaCarry, encode};
        let dir = std::env::temp_dir().join(format!("gvi-paste-p3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p3.png");
        let opts = ExportOptions {
            format: ExportFormat::Png,
            quality: None,
            alpha: true,
            depth16: false,
            strip_metadata: false,
            resize: None,
            color_profile: Some("display-p3".into()),
        };
        let img = solid(4, 3, [215, 93, 31, 255]);
        std::fs::write(&path, encode(&img, &opts, &MetaCarry::default()).unwrap()).unwrap();
        let got = file_png(&path);
        std::fs::remove_dir_all(&dir).unwrap();
        let px = decode_png(&got.unwrap()).get_pixel(1, 1).0;
        assert!(px.iter().zip([215, 93, 31, 255]).all(|(a, b)| a.abs_diff(b) <= 2), "{px:?}");
    }

    #[test]
    fn copiar_sem_mascara_compoe_as_anotacoes_na_imagem_inteira() {
        let base = solid(4, 4, [0, 0, 255, 255]);
        let mut over = solid(4, 4, [0, 0, 0, 0]);
        over.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        let out = flattened_region(&base, None, Some(png_bytes(&over).unwrap())).unwrap();
        assert_eq!(out.dimensions(), (4, 4));
        assert_eq!(out.get_pixel(0, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(out.get_pixel(3, 3), &Rgba([0, 0, 255, 255]));
    }

    #[test]
    fn copiar_com_mascara_recorta_depois_de_compor() {
        let base = solid(4, 4, [0, 0, 255, 255]);
        let mut over = solid(4, 4, [0, 0, 0, 0]);
        over.put_pixel(2, 2, Rgba([255, 0, 0, 255]));
        let mask = Mask::Rect(Rect { x: 2, y: 2, w: 2, h: 2 });
        let out = flattened_region(&base, Some(&mask), Some(png_bytes(&over).unwrap())).unwrap();
        assert_eq!(out.dimensions(), (2, 2));
        assert_eq!(out.get_pixel(0, 0), &Rgba([255, 0, 0, 255]));
        // Sem anotações é a mesma região de `copy_region`.
        assert_eq!(flattened_region(&base, Some(&mask), None).unwrap(), solid(2, 2, [0, 0, 255, 255]));
    }
}
