//! Texto ao Vivo (Lote 3): OCR em Rust puro com os modelos PP-OCRv5 (Apache-2.0) rodando no
//! `rten`, e leitura de QR code com o `rqrr`.
//!
//! - Detecção: `PP-OCRv5_mobile_det` (DB). O mapa de probabilidade vira caixas por componentes
//!   conexos (caixas alinhadas aos eixos: texto horizontal ou pouco inclinado).
//! - Reconhecimento: `latin_PP-OCRv5_mobile_rec` (CTC). O dicionário latino tem os acentos do
//!   português (ã, ç, é, ô…). As caixas das palavras saem dos passos de tempo do CTC.
//!
//! Os modelos não vão no repositório nem no pacote: `commands/ocr.rs` baixa sob demanda e confere
//! o SHA-256 de `MODELS`. Origem, licença e hashes estão em `docs/arquitetura/ocr.md`.
use crate::{
    doc::model::Rect,
    error::{AppError, AppResult},
};
use ::image::{RgbaImage, imageops};
use rayon::prelude::*;
use rten::Model;
use rten_tensor::{NdTensor, NdTensorView, prelude::*};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

/// Palavra reconhecida, em px da imagem.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextWord {
    pub text: String,
    pub bbox: Rect,
}

/// Linha reconhecida, com as palavras na ordem de leitura.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub text: String,
    pub bbox: Rect,
    pub words: Vec<TextWord>,
}

/// QR code lido na imagem.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCode {
    pub text: String,
    pub bbox: Rect,
}

/// Modelo baixado sob demanda.
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

/// Detecção e reconhecimento: conversões ONNX dos modelos do PaddleOCR publicadas pelo RapidOCR
/// (RapidAI, Apache-2.0).
pub const MODELS: [ModelSpec; 2] = [
    ModelSpec {
        file: "ch_PP-OCRv5_det_mobile.onnx",
        url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx",
        sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
        size: 4_819_576,
    },
    ModelSpec {
        file: "latin_PP-OCRv5_rec_mobile.onnx",
        url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile.onnx",
        sha256: "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a",
        size: 7_904_513,
    },
];

/// Dicionário do `latin_PP-OCRv5_mobile_rec` (PaddleOCR, Apache-2.0): índice CTC `i` = linha `i-1`;
/// o índice depois da última linha é o espaço.
const LATIN_DICT: &str = include_str!("ocr_latin_dict.txt");

/// SHA-256 do arquivo em hexadecimal minúsculo.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// O arquivo existe, tem o tamanho e o hash esperados.
pub fn model_ok(dir: &Path, spec: &ModelSpec) -> bool {
    let p = dir.join(spec.file);
    std::fs::metadata(&p).is_ok_and(|m| m.len() == spec.size)
        && sha256_file(&p).is_ok_and(|h| h == spec.sha256)
}

// ---------- Parâmetros (os padrões do PaddleOCR) ----------

const DET_THRESH: f32 = 0.3;
const DET_BOX_THRESH: f32 = 0.6;
const DET_UNCLIP: f32 = 1.5;
/// Lado maior da entrada da detecção: imagens maiores são reduzidas, menores ampliadas até `DET_MIN`.
const DET_MAX: f32 = 1600.0;
const DET_MIN: f32 = 640.0;
const REC_H: u32 = 48;
const REC_MAX_W: u32 = 48 * 80;
/// Linhas com confiança média abaixo disso são descartadas (detecções espúrias).
const MIN_CONFIDENCE: f32 = 0.5;

/// Caixa em px (ponto flutuante).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoxF {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl BoxF {
    fn cy(&self) -> f32 {
        (self.y0 + self.y1) / 2.0
    }
    /// Arredonda para fora e limita a `w`×`h`.
    pub fn to_rect(self, w: u32, h: u32) -> Rect {
        let x0 = self.x0.floor().clamp(0.0, w as f32) as u32;
        let y0 = self.y0.floor().clamp(0.0, h as f32) as u32;
        let x1 = self.x1.ceil().clamp(0.0, w as f32) as u32;
        let y1 = self.y1.ceil().clamp(0.0, h as f32) as u32;
        Rect { x: x0, y: y0, w: x1.saturating_sub(x0), h: y1.saturating_sub(y0) }
    }
}

/// Pixel RGBA sobre branco (texto em PNG transparente continua legível), em BGR, 0..255.
fn bgr_over_white(p: &::image::Rgba<u8>) -> [f32; 3] {
    let a = p[3] as f32 / 255.0;
    let c = |v: u8| v as f32 * a + 255.0 * (1.0 - a);
    [c(p[2]), c(p[1]), c(p[0])]
}

/// Tamanho da entrada da detecção: múltiplos de 32, lado maior entre `DET_MIN` e `DET_MAX`.
pub fn det_size(w: u32, h: u32) -> (u32, u32) {
    let max = w.max(h) as f32;
    let s = if max > DET_MAX { DET_MAX / max } else if max < DET_MIN { (DET_MIN / max).min(4.0) } else { 1.0 };
    let r = |v: u32| (((v as f32 * s) / 32.0).round() as u32).max(1) * 32;
    (r(w), r(h))
}

/// Tensor `[1, 3, H, W]` normalizado como no PaddleOCR (BGR, média/desvio do ImageNet).
fn det_input(img: &RgbaImage) -> NdTensor<f32, 4> {
    let (w, h) = det_size(img.width(), img.height());
    let small = imageops::resize(img, w, h, imageops::FilterType::Triangle);
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let mut t = NdTensor::<f32, 4>::zeros([1, 3, h as usize, w as usize]);
    for (x, y, p) in small.enumerate_pixels() {
        let bgr = bgr_over_white(p);
        for c in 0..3 {
            t[[0, c, y as usize, x as usize]] = (bgr[c] / 255.0 - MEAN[c]) / STD[c];
        }
    }
    t
}

/// Pós-processamento DB: componentes conexos (4-vizinhança) de `prob > DET_THRESH`, nota média
/// da caixa ≥ `DET_BOX_THRESH` e expansão ("unclip") de `área × 1,5 / perímetro`. Caixas no
/// espaço do mapa.
pub fn db_boxes(prob: NdTensorView<f32, 2>) -> Vec<BoxF> {
    let [h, w] = prob.shape();
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if seen[start] || prob[[start / w, start % w]] <= DET_THRESH {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
        while let Some(i) = stack.pop() {
            let (y, x) = (i / w, i % w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            let mut push = |j: usize| {
                if !seen[j] && prob[[j / w, j % w]] > DET_THRESH {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                push(i - 1);
            }
            if x + 1 < w {
                push(i + 1);
            }
            if y > 0 {
                push(i - w);
            }
            if y + 1 < h {
                push(i + w);
            }
        }
        let (bw, bh) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
        if bw.min(bh) < 3.0 {
            continue;
        }
        let mut sum = 0.0;
        for y in y0..=y1 {
            for x in x0..=x1 {
                sum += prob[[y, x]];
            }
        }
        if sum / (bw * bh) < DET_BOX_THRESH {
            continue;
        }
        let d = bw * bh * DET_UNCLIP / (2.0 * (bw + bh));
        out.push(BoxF {
            x0: x0 as f32 - d,
            y0: y0 as f32 - d,
            x1: (x1 + 1) as f32 + d,
            y1: (y1 + 1) as f32 + d,
        });
    }
    out
}

/// Ordem de leitura: de cima para baixo e, na mesma faixa (centro dentro da altura da primeira
/// caixa da faixa), da esquerda para a direita.
pub fn reading_order(mut boxes: Vec<BoxF>) -> Vec<BoxF> {
    boxes.sort_by(|a, b| a.cy().total_cmp(&b.cy()));
    let mut out = Vec::with_capacity(boxes.len());
    let mut row: Vec<BoxF> = Vec::new();
    for b in boxes {
        if let Some(first) = row.first()
            && (b.cy() < first.y0 || b.cy() > first.y1)
        {
            row.sort_by(|a, b| a.x0.total_cmp(&b.x0));
            out.append(&mut row);
        }
        row.push(b);
    }
    row.sort_by(|a, b| a.x0.total_cmp(&b.x0));
    out.append(&mut row);
    out
}

/// Caractere decodificado e o passo de tempo em que apareceu.
#[derive(Debug, Clone, PartialEq)]
pub struct CtcChar {
    pub text: String,
    pub t: usize,
}

/// Decodificação CTC gulosa (argmax, junta repetidos, tira o branco 0). Devolve os caracteres e
/// a confiança média (probabilidade dos caracteres emitidos).
pub fn ctc_decode(probs: NdTensorView<f32, 2>, dict: &[&str]) -> (Vec<CtcChar>, f32) {
    let [steps, classes] = probs.shape();
    let mut out = Vec::new();
    let mut conf = 0.0;
    let mut prev = 0;
    for t in 0..steps {
        let (best, p) = (0..classes)
            .map(|c| (c, probs[[t, c]]))
            .fold((0, f32::MIN), |a, b| if b.1 > a.1 { b } else { a });
        if best != 0 && best != prev {
            let text = dict.get(best - 1).copied().unwrap_or(" ");
            out.push(CtcChar { text: text.to_string(), t });
            conf += p;
        }
        prev = best;
    }
    let n = out.len();
    (out, if n == 0 { 0.0 } else { conf / n as f32 })
}

/// Monta a linha: palavras separadas por espaço, com a caixa horizontal tirada dos passos de
/// tempo (`step` px da imagem por passo, a partir de `line.x0`).
pub fn build_line(chars: &[CtcChar], line: BoxF, step: f32, img_w: u32, img_h: u32) -> Option<TextLine> {
    let mut words = Vec::new();
    let mut cur: Vec<&CtcChar> = Vec::new();
    let flush = |cur: &mut Vec<&CtcChar>, words: &mut Vec<TextWord>| {
        if let (Some(a), Some(b)) = (cur.first(), cur.last()) {
            let x0 = (line.x0 + a.t as f32 * step).max(line.x0);
            let x1 = (line.x0 + (b.t + 1) as f32 * step).min(line.x1);
            let text: String = cur.iter().map(|c| c.text.as_str()).collect();
            words.push(TextWord { text, bbox: BoxF { x0, x1, ..line }.to_rect(img_w, img_h) });
        }
        cur.clear();
    };
    for c in chars {
        if c.text.trim().is_empty() {
            flush(&mut cur, &mut words);
        } else {
            cur.push(c);
        }
    }
    flush(&mut cur, &mut words);
    if words.is_empty() {
        return None;
    }
    let text = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    Some(TextLine { text, bbox: line.to_rect(img_w, img_h), words })
}

/// Tensor `[1, 3, 48, W]` da linha recortada (BGR, `(v/255 - 0,5) / 0,5`).
fn rec_input(img: &RgbaImage, r: Rect) -> NdTensor<f32, 4> {
    let crop = imageops::crop_imm(img, r.x, r.y, r.w, r.h).to_image();
    let w = ((r.w as f32 * REC_H as f32 / r.h as f32).round() as u32).clamp(8, REC_MAX_W);
    let small = imageops::resize(&crop, w, REC_H, imageops::FilterType::Triangle);
    let mut t = NdTensor::<f32, 4>::zeros([1, 3, REC_H as usize, w as usize]);
    for (x, y, p) in small.enumerate_pixels() {
        let bgr = bgr_over_white(p);
        for c in 0..3 {
            t[[0, c, y as usize, x as usize]] = bgr[c] / 127.5 - 1.0;
        }
    }
    t
}

fn model_err(e: impl std::fmt::Display) -> AppError {
    AppError::Corrupt(format!("ocr: {e}"))
}

/// Erro devolvido quando o pedido foi cancelado (outro documento ficou ativo).
pub fn cancelled_error() -> AppError {
    AppError::Unsupported("ocr: cancelado".into())
}

/// Os dois modelos carregados (caro: carregue uma vez e reaproveite).
pub struct Engine {
    det: Model,
    rec: Model,
    dict: Vec<&'static str>,
}

impl Engine {
    pub fn load(dir: &Path) -> AppResult<Self> {
        let load = |spec: &ModelSpec| Model::load_file(dir.join(spec.file)).map_err(model_err);
        Ok(Self { det: load(&MODELS[0])?, rec: load(&MODELS[1])?, dict: LATIN_DICT.lines().collect() })
    }

    /// Reconhece o texto. `cancelled` é consultado entre as etapas; se der `true`, devolve
    /// `cancelled_error()`.
    pub fn recognize(&self, img: &RgbaImage, cancelled: &(dyn Fn() -> bool + Sync)) -> AppResult<Vec<TextLine>> {
        let (iw, ih) = img.dimensions();
        if iw == 0 || ih == 0 {
            return Ok(Vec::new());
        }
        let input = det_input(img);
        let [_, _, dh, dw] = input.shape();
        let out: NdTensor<f32, 4> = self
            .det
            .run_one(input.view().into(), None)
            .map_err(model_err)?
            .try_into()
            .map_err(model_err)?;
        if cancelled() {
            return Err(cancelled_error());
        }
        let (sx, sy) = (iw as f32 / dw as f32, ih as f32 / dh as f32);
        let boxes: Vec<BoxF> = db_boxes(out.slice((0, 0)))
            .into_iter()
            .map(|b| BoxF { x0: b.x0 * sx, y0: b.y0 * sy, x1: b.x1 * sx, y1: b.y1 * sy })
            .collect();
        let lines: Vec<AppResult<Option<TextLine>>> = reading_order(boxes)
            .into_par_iter()
            .map(|b| {
                if cancelled() {
                    return Err(cancelled_error());
                }
                let r = b.to_rect(iw, ih);
                if r.w < 2 || r.h < 2 {
                    return Ok(None);
                }
                let t = rec_input(img, r);
                let probs: NdTensor<f32, 3> = self
                    .rec
                    .run_one(t.view().into(), None)
                    .map_err(model_err)?
                    .try_into()
                    .map_err(model_err)?;
                let (chars, conf) = ctc_decode(probs.slice(0), &self.dict);
                if conf < MIN_CONFIDENCE {
                    return Ok(None);
                }
                // A linha (`r.w` px da imagem) cobre todos os passos de tempo da saída.
                let step = r.w as f32 / probs.shape()[1].max(1) as f32;
                let line = BoxF { x0: r.x as f32, y0: r.y as f32, x1: (r.x + r.w) as f32, y1: (r.y + r.h) as f32 };
                Ok(build_line(&chars, line, step, iw, ih))
            })
            .collect();
        let mut out = Vec::new();
        for l in lines {
            out.extend(l?);
        }
        Ok(out)
    }
}

/// QR codes da imagem (sobre branco, em tons de cinza).
pub fn detect_codes(img: &RgbaImage) -> Vec<DetectedCode> {
    let (w, h) = img.dimensions();
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(w as usize, h as usize, |x, y| {
        let [b, g, r] = bgr_over_white(img.get_pixel(x as u32, y as u32));
        (0.299 * r + 0.587 * g + 0.114 * b).round() as u8
    });
    prepared
        .detect_grids()
        .into_iter()
        .filter_map(|g| {
            let (_, text) = g.decode().ok()?;
            let xs = g.bounds.iter().map(|p| p.x as f32);
            let ys = g.bounds.iter().map(|p| p.y as f32);
            let bbox = BoxF {
                x0: xs.clone().fold(f32::MAX, f32::min),
                x1: xs.fold(f32::MIN, f32::max),
                y0: ys.clone().fold(f32::MAX, f32::min),
                y1: ys.fold(f32::MIN, f32::max),
            };
            Some(DetectedCode { text, bbox: bbox.to_rect(w, h) })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_dos_modelos() {
        assert!(MODELS.iter().all(|m| m.url.ends_with(m.file) && m.sha256.len() == 64));
    }

    #[test]
    fn dicionario_tem_acentos_do_portugues() {
        let dict: Vec<&str> = LATIN_DICT.lines().collect();
        assert_eq!(dict.len(), 502, "504 classes do modelo = branco + 502 + espaço");
        for c in ["ã", "ç", "é", "ê", "ó", "ô", "õ", "ú", "à", "Ç", "Ã"] {
            assert!(dict.contains(&c), "{c}");
        }
    }

    #[test]
    fn det_size_limita_e_arredonda_em_32() {
        assert_eq!(det_size(6000, 4000), (1600, 1056));
        assert_eq!(det_size(900, 260), (896, 256));
        let (w, h) = det_size(100, 20);
        assert_eq!((w, h), (416, 96), "imagem pequena é ampliada até 4x");
        assert_eq!(det_size(1, 1), (32, 32));
    }

    fn map(w: usize, h: usize, rects: &[(usize, usize, usize, usize, f32)]) -> NdTensor<f32, 2> {
        let mut m = NdTensor::<f32, 2>::zeros([h, w]);
        for &(x0, y0, x1, y1, v) in rects {
            for y in y0..y1 {
                for x in x0..x1 {
                    m[[y, x]] = v;
                }
            }
        }
        m
    }

    #[test]
    fn db_separa_componentes_e_expande() {
        let m = map(100, 40, &[(10, 10, 40, 16, 0.9), (60, 10, 90, 16, 0.9), (10, 30, 12, 32, 0.9)]);
        let b = db_boxes(m.view());
        assert_eq!(b.len(), 2, "o componente 2×2 (< 3 px) é descartado");
        // 30×6: d = 180 × 1,5 / 72 = 3,75
        assert_eq!(b[0], BoxF { x0: 6.25, y0: 6.25, x1: 43.75, y1: 19.75 });
    }

    #[test]
    fn db_descarta_caixa_de_nota_baixa() {
        let m = map(50, 20, &[(5, 5, 40, 12, 0.4)]);
        assert!(db_boxes(m.view()).is_empty());
    }

    fn bx(x0: f32, y0: f32, x1: f32, y1: f32) -> BoxF {
        BoxF { x0, y0, x1, y1 }
    }

    #[test]
    fn ordem_de_leitura_por_faixas() {
        let a = bx(200.0, 10.0, 300.0, 30.0);
        let b = bx(10.0, 12.0, 150.0, 32.0);
        let c = bx(10.0, 50.0, 100.0, 70.0);
        assert_eq!(reading_order(vec![c, a, b]), vec![b, a, c]);
    }

    #[test]
    fn ctc_junta_repetidos_e_tira_branco() {
        let dict = ["a", "ç", "o"];
        // classes: 0 branco, 1 a, 2 ç, 3 o, 4 espaço
        let seq = [2, 2, 0, 3, 4, 1, 1, 0, 1];
        let mut p = NdTensor::<f32, 2>::zeros([seq.len(), 5]);
        for (t, &c) in seq.iter().enumerate() {
            p[[t, c]] = 0.9;
        }
        let (chars, conf) = ctc_decode(p.view(), &dict);
        let s: String = chars.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(s, "ço aa");
        assert_eq!(chars.iter().map(|c| c.t).collect::<Vec<_>>(), vec![0, 3, 4, 5, 8]);
        assert!((conf - 0.9).abs() < 1e-6);
    }

    #[test]
    fn linha_com_caixas_das_palavras() {
        let ch = |text: &str, t| CtcChar { text: text.into(), t };
        let chars = [ch("O", 0), ch("i", 1), ch(" ", 2), ch("v", 4), ch("ó", 5)];
        let l = build_line(&chars, bx(100.0, 10.0, 160.0, 30.0), 10.0, 1000, 1000).unwrap();
        assert_eq!(l.text, "Oi vó");
        assert_eq!(l.bbox, Rect { x: 100, y: 10, w: 60, h: 20 });
        assert_eq!(l.words[0].bbox, Rect { x: 100, y: 10, w: 20, h: 20 });
        assert_eq!(l.words[1].bbox, Rect { x: 140, y: 10, w: 20, h: 20 });
        assert!(build_line(&[ch(" ", 0)], bx(0.0, 0.0, 9.0, 9.0), 1.0, 9, 9).is_none());
    }

    #[test]
    fn caixa_fora_da_imagem_e_limitada() {
        assert_eq!(bx(-3.2, -1.0, 12.1, 50.0).to_rect(10, 20), Rect { x: 0, y: 0, w: 10, h: 20 });
    }

    #[test]
    fn transparente_vira_branco() {
        assert_eq!(bgr_over_white(&::image::Rgba([0, 0, 0, 0])), [255.0; 3]);
        assert_eq!(bgr_over_white(&::image::Rgba([10, 20, 30, 255])), [30.0, 20.0, 10.0]);
    }

    #[test]
    fn hash_de_arquivo() {
        let dir = std::env::temp_dir().join(format!("gvi-ocr-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let spec = ModelSpec { file: "x", url: "", sha256: "00", size: 3 };
        assert!(!model_ok(&dir, &spec), "hash errado");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn le_qr_code() {
        let code = qrcode::QrCode::new(b"https://exemplo.com.br/a\xc3\xa7\xc3\xa3o").unwrap();
        let w = code.width();
        let px = 6;
        let quiet = 4 * px;
        let side = (w * px + 2 * quiet) as u32;
        let colors = code.to_colors();
        let img = RgbaImage::from_fn(side, side, |x, y| {
            let (x, y) = (x as i64 - quiet as i64, y as i64 - quiet as i64);
            let dark = x >= 0
                && y >= 0
                && (x as usize) < w * px
                && (y as usize) < w * px
                && colors[(y as usize / px) * w + x as usize / px] == qrcode::Color::Dark;
            if dark { ::image::Rgba([0, 0, 0, 255]) } else { ::image::Rgba([255, 255, 255, 255]) }
        });
        let codes = detect_codes(&img);
        assert_eq!(codes.len(), 1);
        assert_eq!(codes[0].text, "https://exemplo.com.br/ação");
        let b = codes[0].bbox;
        assert!(b.x.abs_diff(quiet as u32) <= px as u32 && b.w.abs_diff((w * px) as u32) <= 2 * px as u32, "{b:?}");
    }
}
