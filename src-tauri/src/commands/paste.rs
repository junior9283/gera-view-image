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
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    path::Path,
    sync::{Mutex, PoisonError},
};
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

/// Camada colada em PNG: a imagem da área de transferência é sRGB e a interface desenha (e
/// achata) a camada como cor de tela.
pub fn layer_png(mut img: RgbaImage) -> AppResult<Vec<u8>> {
    icc::to_display(&mut img, None);
    png_bytes(&img)
}

/// O que Copiar põe na área de transferência: a região da página `frame` de `id` em sRGB (o
/// conteúdo vai sem perfil), com as anotações `png` compostas por cima, igual ao que está na tela.
pub fn copied_region(
    store: &DocStore,
    id: DocId,
    frame: u32,
    mask: Option<&Mask>,
    png: Option<Vec<u8>>,
) -> AppResult<RgbaImage> {
    let img = store.render_full(id, frame)?;
    let png = png.map(|png| store.png_from_display(id, png));
    let region = flattened_region(&img, mask, png).ok_or(AppError::EmptySelection)?;
    if !icc::enabled() {
        return Ok(region);
    }
    Ok(store.to_srgb(id, Cow::Owned(region)).into_owned())
}

/// Região de `img` com as anotações (`png`, no tamanho da imagem) compostas por cima.
fn flattened_region(img: &RgbaImage, mask: Option<&Mask>, png: Option<Vec<u8>>) -> Option<RgbaImage> {
    let flat = png.map(|png| ops::apply(img, &Op::Composite { png, frame: None }));
    select::extract_region(flat.as_ref().unwrap_or(img), mask)
}

/// PNG da imagem na área de transferência (bytes crus), para virar anotação `image`.
#[tauri::command]
pub async fn clipboard_image(app: AppHandle) -> AppResult<Response> {
    let img = app.clipboard().read_image().map_err(|_| AppError::ClipboardEmpty)?;
    let rgba = RgbaImage::from_raw(img.width(), img.height(), img.rgba().to_vec())
        .ok_or(AppError::ClipboardEmpty)?;
    blocking(move || layer_png(rgba)).await.map(Response::new)
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
    frame: Option<u32>,
) -> AppResult<()> {
    let store = store.inner().clone();
    let frame = frame.unwrap_or(0);
    let region = blocking(move || copied_region(&store, id, frame, mask.as_ref(), png)).await?;
    let (w, h) = region.dimensions();
    app.clipboard()
        .write_image(&Image::new_owned(region.into_raw(), w, h))
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Teto do JSON das anotações copiadas (assinaturas e camadas coladas vão em PNG base64).
const MAX_ANNOTATIONS: usize = 64 << 20;

/// Anotações copiadas, para qualquer janela colar. Só valem enquanto o desenho delas ainda for o que
/// está na área de transferência do sistema: copiar outra coisa, em qualquer app, as substitui.
#[derive(Default)]
pub struct AnnotationClipboard(Mutex<Option<Copied>>);

struct Copied {
    data: String,
    digest: [u8; 32],
}

fn digest(w: u32, h: u32, rgba: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(w.to_le_bytes())
        .chain_update(h.to_le_bytes())
        .chain_update(rgba)
        .finalize()
        .into()
}

impl AnnotationClipboard {
    fn set(&self, data: String, digest: [u8; 32]) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(Copied { data, digest });
    }

    fn is_empty(&self) -> bool {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).is_none()
    }

    /// As anotações, se `current` (o resumo da imagem do sistema agora) é o desenho delas; senão
    /// esquece as antigas.
    fn matching(&self, current: Option<[u8; 32]>) -> Option<String> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().map(|c| c.digest) != current {
            *slot = None;
        }
        slot.as_ref().map(|c| c.data.clone())
    }
}

fn check_annotations(data: &str) -> AppResult<()> {
    if data.len() > MAX_ANNOTATIONS {
        return Err(AppError::Unsupported("anotações grandes demais para copiar".into()));
    }
    Ok(())
}

/// Copia anotações: `data` (JSON) fica aqui e `png`, o desenho, vai para a área de transferência.
#[tauri::command]
pub async fn copy_annotations(
    app: AppHandle,
    copied: State<'_, AnnotationClipboard>,
    data: String,
    png: Vec<u8>,
) -> AppResult<()> {
    check_annotations(&data)?;
    let img = blocking(move || {
        ::image::load_from_memory_with_format(&png, ::image::ImageFormat::Png)
            .map(|i| i.into_rgba8())
            .map_err(AppError::from)
    })
    .await?;
    let (w, h) = img.dimensions();
    let digest = digest(w, h, img.as_raw());
    app.clipboard()
        .write_image(&Image::new_owned(img.into_raw(), w, h))
        .map_err(|e| AppError::Io(e.to_string()))?;
    copied.set(data, digest);
    Ok(())
}

/// As anotações copiadas, ou `None` se a última cópia do sistema já é outra coisa.
#[tauri::command]
pub async fn pasted_annotations(
    app: AppHandle,
    copied: State<'_, AnnotationClipboard>,
) -> AppResult<Option<String>> {
    if copied.is_empty() {
        return Ok(None);
    }
    let current = app.clipboard().read_image().ok();
    Ok(copied.matching(current.map(|i| digest(i.width(), i.height(), i.rgba()))))
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
    fn anotacoes_copiadas_valem_ate_a_proxima_copia() {
        let clip = AnnotationClipboard::default();
        let sum = |c: [u8; 4], w: u32, h: u32| digest(w, h, solid(w, h, c).as_raw());
        assert!(clip.is_empty());
        assert_eq!(clip.matching(Some(sum([0; 4], 2, 2))), None);

        clip.set("ação".into(), sum([1, 2, 3, 4], 2, 3));
        let seen = Some(sum([1, 2, 3, 4], 2, 3));
        assert_eq!(clip.matching(seen).as_deref(), Some("ação"));
        assert_eq!(clip.matching(seen).as_deref(), Some("ação")); // cola quantas vezes quiser

        // Os mesmos bytes noutro formato não são a mesma imagem; e a antiga não volta.
        assert_eq!(clip.matching(Some(sum([1, 2, 3, 4], 3, 2))), None);
        assert!(clip.is_empty());
        assert_eq!(clip.matching(seen), None);

        // Sem imagem no sistema (copiaram um texto): também não valem mais.
        clip.set("x".into(), sum([9; 4], 1, 1));
        assert_eq!(clip.matching(None), None);
        assert!(clip.is_empty());
    }

    #[test]
    fn anotacoes_grandes_demais_sao_recusadas() {
        assert!(check_annotations(&"a".repeat(MAX_ANNOTATIONS)).is_ok());
        assert_eq!(
            check_annotations(&"a".repeat(MAX_ANNOTATIONS + 1)).unwrap_err().code(),
            "unsupported"
        );
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
            ..ExportOptions::new(ExportFormat::Png)
        };
        let img = solid(4, 3, [215, 93, 31, 255]);
        std::fs::write(&path, encode(&img, &opts, &MetaCarry::default()).unwrap()).unwrap();
        let got = file_png(&path);
        std::fs::remove_dir_all(&dir).unwrap();
        let px = decode_png(&got.unwrap()).get_pixel(1, 1).0;
        assert!(px.iter().zip([215, 93, 31, 255]).all(|(a, b)| a.abs_diff(b) <= 2), "{px:?}");
    }

    fn store_with(icc: Option<&str>) -> (DocStore, DocId) {
        let store = DocStore::new();
        let decoded = decode::Decoded {
            icc: icc.map(|id| icc::profile_bytes(id).unwrap().to_vec()),
            ..decode::Decoded::single(
                solid(4, 3, [200, 100, 50, 255]),
                crate::doc::model::SourceFormat::Png,
            )
        };
        let id = store.insert_decoded("", decoded).id;
        (store, id)
    }

    #[track_caller]
    fn near(got: &[u8], want: [u8; 3], tol: u8) {
        let ok = got[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= tol);
        assert!(ok, "obtido {got:?}, esperado {want:?} (±{tol})");
    }

    #[test]
    fn copiar_colar_e_achatar_em_p3_preserva_a_cor_vista() {
        let (store, id) = store_with(Some("display-p3"));
        let seen = store.render_view(id, 0, 4, 3, None).unwrap()[8..12].to_vec();
        let copied = copied_region(&store, id, 0, None, None).unwrap();
        near(&copied.get_pixel(1, 1).0, [215, 93, 31], 2);
        let png = layer_png(copied).unwrap();
        store.apply_op(id, Op::Composite { png, frame: None }).unwrap();
        near(
            &store.render_view(id, 0, 4, 3, None).unwrap()[8..12],
            [seen[0], seen[1], seen[2]],
            2,
        );
        near(&store.render_full(id, 0).unwrap().get_pixel(1, 1).0, [200, 100, 50], 2);
    }

    #[test]
    fn copiar_com_anotacao_em_p3_sai_com_a_cor_da_tela() {
        let (store, id) = store_with(Some("display-p3"));
        let mut over = solid(4, 3, [0, 0, 0, 0]);
        over.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        let out = copied_region(&store, id, 0, None, Some(png_bytes(&over).unwrap())).unwrap();
        near(&out.get_pixel(0, 0).0, [255, 0, 0], 1);
        near(&out.get_pixel(3, 2).0, [215, 93, 31], 2);
    }

    #[test]
    fn copiar_documento_srgb_e_identico() {
        for profile in [None, Some("srgb")] {
            let (store, id) = store_with(profile);
            let original = store.render_full(id, 0).unwrap().clone();
            assert_eq!(copied_region(&store, id, 0, None, None).unwrap(), original);
            let mask = Mask::Rect(Rect { x: 1, y: 1, w: 2, h: 2 });
            let part = copied_region(&store, id, 0, Some(&mask), None).unwrap();
            assert_eq!(part, solid(2, 2, [200, 100, 50, 255]));
            assert_eq!(decode_png(&layer_png(original.clone()).unwrap()), original);
        }
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
