//! Tipos centrais do contrato (espelhados em `src/ipc/types.ts`).
//!
//! Serialização: structs em `camelCase`; enums com dados (`Op`, `Mask`) usam
//! marcação adjacente `{ "type": "...", "data": ... }` (variantes sem dados: só `type`).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DocId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceFormat {
    Jpeg,
    Png,
    Gif,
    Bmp,
    Tiff,
    Webp,
    Heic,
    Avif,
    Ico,
    Svg,
    Psd,
    Tga,
    Raw,
    Jp2,
}

impl SourceFormat {
    /// Formatos que o Salvar grava no próprio arquivo (spec §13.7). RAW, PSD, SVG, ICO, GIF
    /// e TGA vão para Exportar. Documentos de várias páginas/quadros são decididos em
    /// `Document::can_save`.
    pub fn writable(self) -> bool {
        use SourceFormat::*;
        matches!(self, Jpeg | Png | Tiff | Webp | Avif | Bmp | Heic | Jp2)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub id: DocId,
    pub path: String,
    pub name: String,
    pub format: SourceFormat,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    /// Tamanho de cada página, depois das operações (TIFF de várias páginas); vazio nos outros.
    pub page_sizes: Vec<(u32, u32)>,
    /// Atraso de cada quadro em ms (já com a regra dos navegadores); vazio sem animação.
    pub delays_ms: Vec<u32>,
    /// Vezes que a animação toca no total; 0 = para sempre.
    pub plays: u32,
    pub writable: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub rev: u64,
    /// Código de `AppError` (`corrupt`, `unsupported`...) quando o arquivo não abriu.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Recorte. Com `mask`, tudo fora dela fica transparente (alfa 0) antes do corte, numa só
/// operação (um único desfazer). Serializa como o `Rect` mais o campo opcional `mask`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropSpec {
    #[serde(flatten)]
    pub rect: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<Mask>,
}

impl From<Rect> for CropSpec {
    fn from(rect: Rect) -> Self {
        CropSpec { rect, mask: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResizeFilter {
    Nearest,
    Bilinear,
    Lanczos3,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    pub black: u8,
    pub gamma: f32,
    pub white: u8,
}

impl Default for Levels {
    fn default() -> Self {
        Levels {
            black: 0,
            gamma: 1.0,
            white: 255,
        }
    }
}

/// Ajustes de cor; todos neutros em `0.0` (Tarefa 9 implementa).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorAdjust {
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
    pub sepia: f32,
    pub sharpness: f32,
    pub levels: Levels,
}

/// Máscara em coordenadas da imagem (depois das operações anteriores).
///
/// `Bitmap.rle`: comprimentos de corridas alternadas em ordem de linha sobre `w*h`
/// pixels, começando por uma corrida **fora** da máscara (que pode ter tamanho 0).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Mask {
    Rect(Rect),
    Ellipse(Rect),
    Polygon(Vec<(f32, f32)>),
    Bitmap { w: u32, h: u32, rle: Vec<u32> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Op {
    /// Positivo = horário.
    Rotate {
        quarter_turns: i8,
    },
    FlipH,
    FlipV,
    Crop(CropSpec),
    /// `dpi` só altera metadados (resolução gravada na exportação).
    Resize {
        w: u32,
        h: u32,
        filter: ResizeFilter,
        dpi: Option<f32>,
    },
    Adjust(ColorAdjust),
    /// Pixels da máscara ficam totalmente transparentes (`0,0,0,0`).
    Erase(Mask),
    /// Alfa da máscara vai a 0, preservando RGB (Alfa Instantâneo).
    MakeTransparent(Mask),
    /// Anotações achatadas: PNG RGBA composto por cima (src-over), escalado ao tamanho atual.
    /// A interface o envia em cores de tela; `DocStore::apply_op` guarda no espaço do documento.
    Composite {
        #[serde(with = "serde_bytes")]
        png: Vec<u8>,
        /// Só nesta página; `None` = em todas (animação ou imagem simples).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<u32>,
    },
    /// Atribuir Perfil… (Lote 1): reinterpreta os pixels com outro perfil ICC, sem mudá-los.
    /// `profile`: id de `image::icc::BUILTIN` ou caminho absoluto de um .icc/.icm.
    AssignProfile {
        profile: String,
    },
    /// Operação só na página `frame` de um documento de várias páginas. Quem embrulha é
    /// `DocStore::apply_op_on`; vinda pronta da interface, é recusada.
    OnPage {
        frame: u32,
        op: Box<Op>,
    },
}

impl Op {
    /// A operação em si, fora do invólucro de página.
    pub fn inner(&self) -> &Op {
        match self {
            Op::OnPage { op, .. } => op,
            op => op,
        }
    }

    /// Página a que a operação se limita (`None` = a imagem toda).
    pub fn page(&self) -> Option<u32> {
        match self {
            Op::Composite { frame, .. } => *frame,
            Op::OnPage { frame, .. } => Some(*frame),
            _ => None,
        }
    }

    /// A operação não altera os pixels (só como eles são interpretados).
    pub fn keeps_pixels(&self) -> bool {
        matches!(self, Op::AssignProfile { .. })
    }

    /// A operação muda os pixels do quadro `frame`.
    pub fn touches(&self, frame: u32) -> bool {
        self.page().is_none_or(|f| f == frame) && !self.inner().keeps_pixels()
    }
}
