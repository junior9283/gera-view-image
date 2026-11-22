//! Remover Fundo / Copiar Objeto: máscara do sujeito principal com o U²-Netp (ONNX) no
//! `tract` (Rust puro, nada novo no NEEDED).
//!
//! Modelo: `u2netp.onnx` do U²-Net (Qin et al., Apache-2.0, github.com/xuebinqin/U-2-Net),
//! na conversão ONNX publicada pelo rembg (MIT, github.com/danielgatis/rembg). Fica fora do
//! Git e do pacote: é baixado no primeiro uso, com o consentimento do usuário, e só é aceito
//! com o SHA-256 abaixo (`MODEL_SHA256`).
use crate::{
    doc::model::Mask,
    error::{AppError, AppResult},
    image::select::coverage_to_rle,
};
use ::image::{RgbaImage, imageops};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tract_onnx::prelude::*;

pub const MODEL_FILE: &str = "u2netp.onnx";
pub const MODEL_URL: &str =
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
/// SHA-256 do `u2netp.onnx` (4 574 861 bytes; MD5 8e83ca70… publicado pelo rembg).
pub const MODEL_SHA256: &str = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
/// Teto do download: um servidor errado não enche a memória.
pub const MODEL_MAX_BYTES: usize = 16 << 20;

/// Lado da entrada do U²-Netp.
pub const SIDE: usize = 320;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];
/// Diferença mínima entre o maior e o menor valor da previsão para haver um sujeito.
const MIN_CONTRAST: f32 = 0.05;

type Plan = Arc<TypedRunnableModel>;

/// Modelo carregado e otimizado (carregar leva centenas de ms: guarde-o).
pub struct Model(Plan);

fn tract_err(e: impl std::fmt::Display) -> AppError {
    AppError::Corrupt(format!("modelo de segmentação: {e}"))
}

impl Model {
    /// Carrega um ONNX com entrada `[1, 3, SIDE, SIDE]` e saída principal `[1, 1, SIDE, SIDE]`.
    pub fn load(bytes: &[u8]) -> AppResult<Self> {
        let plan = tract_onnx::onnx()
            .model_for_read(&mut &bytes[..])
            .and_then(|m| m.with_input_fact(0, f32::fact([1, 3, SIDE, SIDE]).into()))
            .and_then(|m| m.into_optimized())
            .and_then(|m| m.into_runnable())
            .map_err(tract_err)?;
        Ok(Model(plan))
    }

    /// Probabilidade de cada pixel ser do sujeito, em `SIDE × SIDE`, normalizada para 0..=1.
    /// `None` se a previsão for uniforme (nenhum sujeito destacado).
    pub fn predict(&self, img: &RgbaImage) -> AppResult<Option<Vec<f32>>> {
        let input = Tensor::from_shape(&[1, 3, SIDE, SIDE], &input_data(img)).map_err(tract_err)?;
        let out = self.0.run(tvec!(input.into())).map_err(tract_err)?;
        let pred = out
            .first()
            .ok_or_else(|| tract_err("sem saída"))?
            .try_as_plain_ram()
            .and_then(|v| v.as_slice::<f32>().map(<[f32]>::to_vec))
            .map_err(tract_err)?;
        if pred.len() != SIDE * SIDE {
            return Err(tract_err(format!("saída com {} valores", pred.len())));
        }
        Ok(normalize(pred))
    }
}

/// Entrada NCHW: a imagem reduzida a `SIDE × SIDE`, dividida pelo maior valor e padronizada
/// com média/desvio do ImageNet (o mesmo pré-processamento do rembg).
pub fn input_data(img: &RgbaImage) -> Vec<f32> {
    let small = if img.width() as usize >= SIDE && img.height() as usize >= SIDE {
        imageops::thumbnail(img, SIDE as u32, SIDE as u32)
    } else {
        imageops::resize(
            img,
            SIDE as u32,
            SIDE as u32,
            imageops::FilterType::Triangle,
        )
    };
    let max = small
        .pixels()
        .flat_map(|p| &p.0[..3])
        .copied()
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let plane = SIDE * SIDE;
    let mut data = vec![0f32; 3 * plane];
    for (i, p) in small.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (p.0[c] as f32 / max - MEAN[c]) / STD[c];
        }
    }
    data
}

/// Estica a previsão para 0..=1 (min-max). `None` se ela for praticamente constante.
fn normalize(mut pred: Vec<f32>) -> Option<Vec<f32>> {
    let (lo, hi) = pred
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let span = hi - lo;
    if span.is_nan() || span < MIN_CONTRAST {
        return None;
    }
    pred.iter_mut().for_each(|v| *v = (*v - lo) / span);
    Some(pred)
}

/// Amplia a previsão (`SIDE × SIDE`, bilinear) para `w × h` e binariza em 0,5.
/// `None` se nenhum pixel ficar dentro.
pub fn prediction_to_mask(pred: &[f32], w: u32, h: u32) -> Option<Mask> {
    let n = SIDE as f32;
    let at = |x: usize, y: usize| pred[y.min(SIDE - 1) * SIDE + x.min(SIDE - 1)];
    let cov: Vec<bool> = (0..h as usize)
        .into_par_iter()
        .flat_map_iter(|y| {
            let fy = ((y as f32 + 0.5) * n / h as f32 - 0.5).max(0.0);
            let (y0, ty) = (fy as usize, fy.fract());
            (0..w as usize).map(move |x| {
                let fx = ((x as f32 + 0.5) * n / w as f32 - 0.5).max(0.0);
                let (x0, tx) = (fx as usize, fx.fract());
                let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1, y0) * tx;
                let bot = at(x0, y0 + 1) * (1.0 - tx) + at(x0 + 1, y0 + 1) * tx;
                top * (1.0 - ty) + bot * ty >= 0.5
            })
        })
        .collect();
    cov.iter().any(|&c| c).then(|| Mask::Bitmap {
        w,
        h,
        rle: coverage_to_rle(cov),
    })
}

/// Máscara do sujeito de `img` (`EmptySelection` se não houver sujeito destacado).
pub fn subject_mask(model: &Model, img: &RgbaImage) -> AppResult<Mask> {
    let (w, h) = img.dimensions();
    model
        .predict(img)?
        .and_then(|p| prediction_to_mask(&p, w, h))
        .ok_or(AppError::EmptySelection)
}

// ---------- Modelo em disco ----------

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Grava o modelo baixado em `path` só se o hash bater (atômico: `.part` + rename).
pub fn install_model(path: &Path, bytes: &[u8], sha256: &str) -> AppResult<()> {
    if sha256_hex(bytes) != sha256 {
        return Err(AppError::Corrupt(
            "modelo baixado com hash diferente do esperado".into(),
        ));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = path.with_extension("part");
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, path)?;
    Ok(())
}

/// Lê o modelo de `path`, conferindo o hash (arquivo trocado ou truncado vira `None`).
pub fn read_model(path: &Path, sha256: &str) -> Option<Vec<u8>> {
    std::fs::read(path).ok().filter(|b| sha256_hex(b) == sha256)
}

// ---------- Cancelamento ----------

/// Trabalho de segmentação cancelável: mudar o contador invalida os que já começaram.
#[derive(Debug, Clone, Copy)]
pub struct Job {
    epoch: &'static AtomicU64,
    start: u64,
}

impl Job {
    /// Trabalho ligado a um contador (um por janela).
    pub fn on(epoch: &'static AtomicU64) -> Self {
        Job {
            epoch,
            start: epoch.load(Ordering::SeqCst),
        }
    }

    pub fn cancelled(self) -> bool {
        self.epoch.load(Ordering::SeqCst) != self.start
    }

    /// Erro `io` se o trabalho foi cancelado (a interface já o descartou).
    pub fn check(self) -> AppResult<()> {
        if self.cancelled() {
            Err(AppError::Io("segmentação cancelada".into()))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ::image::Rgba;
    use tract_onnx::pb;

    fn dims(d: &[i64]) -> Option<pb::TypeProto> {
        use pb::tensor_shape_proto::{Dimension, dimension::Value};
        Some(pb::TypeProto {
            value: Some(pb::type_proto::Value::TensorType(pb::type_proto::Tensor {
                elem_type: pb::tensor_proto::DataType::Float as i32,
                shape: Some(pb::TensorShapeProto {
                    dim: d
                        .iter()
                        .map(|&v| Dimension {
                            value: Some(Value::DimValue(v)),
                            ..Default::default()
                        })
                        .collect(),
                }),
            })),
            ..Default::default()
        })
    }

    /// ONNX mínimo no lugar do U²-Netp (o CI não baixa nada): a "probabilidade" é a média
    /// dos três canais padronizados, então pixels claros viram sujeito.
    pub(crate) fn fake_model_bytes() -> Vec<u8> {
        use prost::Message;
        let io = |name: &str, d: &[i64]| pb::ValueInfoProto {
            name: name.into(),
            r#type: dims(d),
            ..Default::default()
        };
        let node = pb::NodeProto {
            input: vec!["x".into()],
            output: vec!["y".into()],
            op_type: "ReduceMean".into(),
            attribute: vec![
                pb::AttributeProto {
                    name: "axes".into(),
                    ints: vec![1],
                    r#type: pb::attribute_proto::AttributeType::Ints as i32,
                    ..Default::default()
                },
                pb::AttributeProto {
                    name: "keepdims".into(),
                    i: 1,
                    r#type: pb::attribute_proto::AttributeType::Int as i32,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let s = SIDE as i64;
        pb::ModelProto {
            ir_version: 7,
            opset_import: vec![pb::OperatorSetIdProto {
                domain: String::new(),
                version: 13,
            }],
            graph: Some(pb::GraphProto {
                name: "fake".into(),
                node: vec![node],
                input: vec![io("x", &[1, 3, s, s])],
                output: vec![io("y", &[1, 1, s, s])],
                ..Default::default()
            }),
            ..Default::default()
        }
        .encode_to_vec()
    }

    /// Fundo escuro com um retângulo claro em `(x0, y0)..(x1, y1)`.
    pub(crate) fn bright_box(w: u32, h: u32, b: (u32, u32, u32, u32)) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let inside = x >= b.0 && x < b.2 && y >= b.1 && y < b.3;
            if inside {
                Rgba([240, 230, 220, 255])
            } else {
                Rgba([20, 30, 40, 255])
            }
        })
    }

    fn coverage(m: &Mask) -> (u32, Vec<bool>) {
        let Mask::Bitmap { w, h, .. } = m else {
            panic!("esperava bitmap")
        };
        (*w, crate::image::ops::mask_coverage(m, *w, *h))
    }

    #[test]
    fn segmenta_o_retangulo_claro_com_o_modelo_onnx() {
        let model = Model::load(&fake_model_bytes()).unwrap();
        let img = bright_box(640, 480, (160, 120, 480, 360));
        let mask = subject_mask(&model, &img).unwrap();
        let (w, cov) = coverage(&mask);
        let at = |x: u32, y: u32| cov[(y * w + x) as usize];
        assert!(at(320, 240) && at(170, 130) && at(470, 350));
        assert!(!at(10, 10) && !at(630, 470) && !at(150, 240) && !at(320, 370));
        let inside = cov.iter().filter(|&&c| c).count() as f64;
        let expected = 320.0 * 240.0;
        assert!(
            (inside - expected).abs() / expected < 0.03,
            "{inside} px dentro"
        );
    }

    #[test]
    fn imagem_menor_que_a_entrada_tambem_segmenta() {
        let model = Model::load(&fake_model_bytes()).unwrap();
        let mask = subject_mask(&model, &bright_box(40, 30, (10, 10, 30, 20))).unwrap();
        let (w, cov) = coverage(&mask);
        assert!(cov[(15 * w + 20) as usize]);
        assert!(!cov[(2 * w + 2) as usize]);
    }

    #[test]
    fn imagem_uniforme_nao_tem_sujeito() {
        let model = Model::load(&fake_model_bytes()).unwrap();
        let img = RgbaImage::from_pixel(100, 80, Rgba([90, 90, 90, 255]));
        assert_eq!(
            subject_mask(&model, &img).unwrap_err(),
            AppError::EmptySelection
        );
    }

    #[test]
    fn modelo_invalido_vira_erro_e_nao_panico() {
        assert_eq!(Model::load(b"nao e onnx").err().unwrap().code(), "corrupt");
    }

    #[test]
    fn entrada_padronizada_pelo_maior_valor() {
        let img = RgbaImage::from_pixel(SIDE as u32, SIDE as u32, Rgba([255, 0, 0, 255]));
        let d = input_data(&img);
        assert_eq!(d.len(), 3 * SIDE * SIDE);
        assert!((d[0] - (1.0 - MEAN[0]) / STD[0]).abs() < 1e-5);
        assert!((d[SIDE * SIDE] - (0.0 - MEAN[1]) / STD[1]).abs() < 1e-5);
    }

    #[test]
    fn previsao_ampliada_preserva_a_regiao() {
        // Metade esquerda = 1, direita = 0: na imagem 100×10, x < 50 fica dentro.
        let pred: Vec<f32> = (0..SIDE * SIDE)
            .map(|i| if i % SIDE < SIDE / 2 { 1.0 } else { 0.0 })
            .collect();
        let m = prediction_to_mask(&pred, 100, 10).unwrap();
        let (w, cov) = coverage(&m);
        assert!(cov[(5 * w + 48) as usize] && !cov[(5 * w + 52) as usize]);
        assert!(prediction_to_mask(&vec![0.0; SIDE * SIDE], 10, 10).is_none());
    }

    #[test]
    fn instala_so_com_o_hash_certo() {
        let dir = std::env::temp_dir().join(format!("gvi-seg-{}", std::process::id()));
        let path = dir.join("models").join(MODEL_FILE);
        let bytes = b"conteudo";
        let hash = sha256_hex(bytes);
        assert_eq!(
            install_model(&path, b"outro", &hash).unwrap_err().code(),
            "corrupt"
        );
        assert!(!path.exists());
        install_model(&path, bytes, &hash).unwrap();
        assert_eq!(read_model(&path, &hash).as_deref(), Some(&bytes[..]));
        assert!(!path.with_extension("part").exists());
        std::fs::write(&path, b"truncado").unwrap();
        assert_eq!(read_model(&path, &hash), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancelar_invalida_so_os_trabalhos_ja_iniciados() {
        static E: AtomicU64 = AtomicU64::new(0);
        let job = Job::on(&E);
        assert!(job.check().is_ok());
        E.fetch_add(1, Ordering::SeqCst);
        assert!(job.cancelled());
        assert_eq!(job.check().unwrap_err().code(), "io");
        assert!(!Job::on(&E).cancelled());
    }

    /// Com o modelo real (`GVI_U2NETP=/caminho/u2netp.onnx cargo test -- --ignored`).
    #[test]
    #[ignore]
    fn u2netp_real_segmenta_um_objeto() {
        let path = std::env::var("GVI_U2NETP").expect("GVI_U2NETP");
        let bytes = read_model(Path::new(&path), MODEL_SHA256).expect("hash do modelo");
        let model = Model::load(&bytes).unwrap();
        // Disco vermelho sobre fundo branco liso.
        let img = RgbaImage::from_fn(600, 400, |x, y| {
            let (dx, dy) = (x as f32 - 300.0, y as f32 - 200.0);
            if dx * dx + dy * dy < 120.0 * 120.0 {
                Rgba([200, 30, 30, 255])
            } else {
                Rgba([250, 250, 250, 255])
            }
        });
        let t = std::time::Instant::now();
        let mask = subject_mask(&model, &img).unwrap();
        eprintln!("u2netp: {:?}", t.elapsed());
        let (w, cov) = coverage(&mask);
        assert!(cov[(200 * w + 300) as usize], "centro do disco");
        assert!(!cov[(10 * w + 10) as usize], "canto do fundo");
    }
}
