// Espelho de `src-tauri/src/doc/model.rs`. Enums com dados usam `{ type, data }`.

export type DocId = number;

export type SourceFormat =
  | "jpeg" | "png" | "gif" | "bmp" | "tiff" | "webp" | "heic"
  | "avif" | "ico" | "svg" | "psd" | "tga" | "raw" | "jp2"
  // Só leitura (L3).
  | "exr" | "hdr" | "pnm" | "icns" | "j2c" | "jxl" | "dds" | "farbfeld";

export type ErrorCode =
  | "not_found"
  | "unsupported"
  | "corrupt"
  | "io"
  | "permission"
  | "changed_on_disk"
  | "heic_decoder_missing"
  | "empty_selection"
  | "clipboard_empty"
  | "too_large";

export interface AppError {
  code: ErrorCode;
  message: string;
}

export interface DocInfo {
  id: DocId;
  path: string;
  name: string;
  format: SourceFormat;
  width: number;
  height: number;
  frames: number;
  /** Largura e altura de cada página, depois das operações (TIFF de várias páginas); vazio nos outros. */
  pageSizes?: [number, number][];
  /** Atraso de cada quadro em ms (atraso de até 10 ms já vira 100 ms); vazio sem animação. */
  delaysMs?: number[];
  /** Vezes que a animação toca no total; 0 = para sempre. */
  plays?: number;
  writable: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Muda a cada alteração visível (operação, desfazer, fim da decodificação completa). */
  rev: number;
  /** Código de `AppError` quando o arquivo não abriu. */
  error: ErrorCode | null;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Item de `start_drag`: `export` = arrastar um PNG temporário em vez do arquivo. */
export interface DragSource { id: DocId; export: boolean }

export type ResizeFilter = "nearest" | "bilinear" | "lanczos3";

export interface Levels { black: number; gamma: number; white: number }

export interface ColorAdjust {
  exposure: number; contrast: number; highlights: number; shadows: number;
  saturation: number; temperature: number; tint: number; sepia: number; sharpness: number;
  levels: Levels;
}

/** 256 faixas por canal e luminância (`histogram`). */
export interface Histogram { r: number[]; g: number[]; b: number[]; l: number[] }

export const NEUTRAL_ADJUST: ColorAdjust = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0,
  temperature: 0, tint: 0, sepia: 0, sharpness: 0, levels: { black: 0, gamma: 1, white: 255 },
};

/** `bitmap.rle`: corridas alternadas sobre w*h, começando por "fora". */
export type Mask =
  | { type: "rect"; data: Rect }
  | { type: "ellipse"; data: Rect }
  | { type: "polygon"; data: [number, number][] }
  | { type: "bitmap"; data: { w: number; h: number; rle: number[] } };

export type Op =
  | { type: "rotate"; data: { quarterTurns: number } }
  | { type: "flipH" }
  | { type: "flipV" }
  /** Com `mask`, o que fica fora dela vira transparente antes do corte (uma op só, um desfazer). */
  | { type: "crop"; data: Rect & { mask?: Mask | null } }
  | { type: "resize"; data: { w: number; h: number; filter: ResizeFilter; dpi: number | null } }
  | { type: "adjust"; data: ColorAdjust }
  | { type: "erase"; data: Mask }
  | { type: "makeTransparent"; data: Mask }
  /** PNG das anotações achatadas. No Rust é `serde_bytes`; pela IPC JSON vai como lista de bytes. */
  | { type: "composite"; data: { png: Uint8Array | number[]; /** Só nesta página (ausente = todas). */ frame?: number } }
  /** Lote 1: Atribuir Perfil… (`profile` como em `ColorProfile.id`); não muda os pixels. */
  | { type: "assignProfile"; data: { profile: string } };

export interface ViewBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Evento emitido pelo Rust quando um documento muda sozinho (ex.: decodificação completa). */
export const DOC_UPDATED_EVENT = "doc-updated";

/** Espelho de `src-tauri/src/image/metadata.rs`. */
export interface GeneralInfo {
  width: number;
  height: number;
  dpi: [number, number] | null;
  colorModel: string;
  profile: string | null;
  depth: number;
  hasAlpha: boolean;
  fileSize: number;
  /** ISO 8601 em UTC. */
  created: string | null;
  modified: string;
}

export interface Gps { lat: number; lon: number; alt: number | null }

export interface Metadata {
  general: GeneralInfo;
  exif: [string, string][];
  iptc: [string, string][];
  gps: Gps | null;
  keywords: string[];
  /** Lote 9: abas por formato que o arquivo tem (`image/formatinfo.rs`). */
  sections: MetaSection[];
  /** Lote 9: aba do fabricante (MakerNote) e dados da lente. */
  maker: { name: string; rows: [string, string][] } | null;
  lens: [string, string][];
  /** Lote 9: textos como estão no arquivo (XMP, depois IPTC e EXIF). */
  texts: MetaTexts;
  /** Blocos que uma gravação levaria: EXIF e textos (XMP ou IPTC). */
  carried?: { exif: boolean; text: boolean };
}

export type MetaSectionId = "tiff" | "jfif" | "png" | "gif" | "heif";
export interface MetaSection { id: MetaSectionId; rows: [string, string][] }

export interface MetaTexts {
  title: string | null;
  description: string | null;
  author: string | null;
  altText: string | null;
}

// ---------- Arquivo (Task 11): espelho de `image/encode.rs` e `doc/file.rs` ----------

export type ExportFormat =
  | "jpeg" | "png" | "tiff" | "heic" | "webp" | "avif" | "jp2" | "exr" | "bmp"
  // Lote 11; os quatro últimos só aparecem com Alt.
  | "pdf" | "gif" | "ico" | "tga" | "psd";

export type TiffCompression = "none" | "lzw" | "packbits" | "deflate";

export interface ExportOptions {
  format: ExportFormat;
  /** 1..100; `null`: JPEG 90, WebP e PDF sem perdas, AVIF 80. */
  quality: number | null;
  alpha: boolean;
  depth16: boolean;
  stripMetadata: boolean;
  resize: [number, number] | null;
  /** Lote 1: perfil de saída (id de `ColorProfile`); ausente/`null` mantém o da imagem. */
  colorProfile?: string | null;
  /** Lote 11: compressão do TIFF (padrão `none`). */
  tiffCompression?: TiffCompression;
  /** Lote 11: OpenEXR em half (16 bits) em vez de float (32 bits). */
  exrHalf?: boolean;
  /** Lote 11: resolução gravada (ppp); ausente/`null` mantém a do documento. */
  dpi?: number | null;
  /** Página gravada (TIFF de várias páginas); ausente = a primeira. */
  frame?: number;
  /** TIFF com todas as páginas do documento (aí `frame` não conta). */
  allPages?: boolean;
}

/** Exportar com etiquetas: `tagsError` diz por que elas não foram gravadas (o arquivo foi). */
export interface TaggedExport {
  info: DocInfo;
  tagsError: { code: string; message: string } | null;
}

export type SaveOutcome = { type: "saved"; data: DocInfo } | { type: "needsExport" };

export type RevertTarget = "lastSaved" | "original";

export type CaptureMode = "selection" | "window" | "screen";

/** Evento do vigia: o arquivo do documento mudou (ou sumiu) fora do app. */
export const DOC_CHANGED_ON_DISK_EVENT = "doc-changed-on-disk";
export interface DiskChanged { id: DocId; removed: boolean }

// ---------- Lotes de paridade: espelho dos stubs do Lote 0 em `src-tauri/src/commands/` ----------

/** Lote 1 (`color.rs`). `id`: "srgb", "display-p3", "adobe-rgb" ou caminho de um .icc. */
export interface ColorProfile { id: string; name: string }

/** Lote 3 (`ocr.rs`): caixas em px da imagem. */
export interface TextWord { text: string; bbox: Rect }
export interface TextLine { text: string; bbox: Rect; words: TextWord[] }
export interface DetectedCode { text: string; bbox: Rect }
/** `downloadBytes`: quanto falta baixar. */
export interface OcrModels { installed: boolean; downloadBytes: number }
export const OCR_MODELS_PROGRESS_EVENT = "ocr-models-progress";
export interface OcrProgress { done: number; total: number }
/** `images` abre a busca por imagem (sem enviar nada); `link` abre http(s), mailto: ou tel:. */
export type WebKind = "translate" | "search" | "images" | "link";
/** Link lido da imagem, reconstruído pelo Rust; `host` em ASCII (punycode), só em http(s). */
export interface LinkInfo { href: string; host: string | null; idn: boolean }

/** Lote 5 (`finder.rs`). `savedAt` em ISO 8601. */
export interface FileVersion { id: string; savedAt: string; size: number }

/** Lote 6 (`share.rs`): `id` = nome do .desktop. */
export interface AppEntry { id: string; name: string; icon: string | null }
/** Lote 6 (`share.rs`): aparelho alcançável no KDE Connect. */
export interface Device { id: string; name: string }

/** Lote 7 (`sidebar.rs`): `null` sem arquivo. */
export interface FileStat { id: DocId; modifiedMs: number | null; size: number | null }

/** Lote 9 (`describe.rs`): `null`/ausente = manter o do arquivo. */
export interface MetadataEdits {
  title?: string | null;
  description?: string | null;
  author?: string | null;
  altText?: string | null;
}

/** Lote 11 (`print.rs`). */
export interface PrintOptions {
  copies: number;
  /** Escala em %; `null` = usar `fit`. */
  scalePercent: number | null;
  fit: "whole" | "fill";
  autoRotate: boolean;
  /** 1, 2, 4, 6, 9 ou 16. */
  perPage: number;
  /** Nome PWG do papel (`iso_a4`, `na_letter`…). */
  paper: string;
  orientation: "portrait" | "landscape";
}

export interface RectF { x: number; y: number; w: number; h: number }

/** Uma imagem na página, em pontos: `rect` é ela inteira (já girada) e `clip` a área que a corta. */
export interface PrintPreviewItem {
  id: DocId;
  frame: number;
  rotated: boolean;
  rect: RectF;
  clip: RectF;
}

export interface PrintPreview {
  paperW: number;
  paperH: number;
  pages: PrintPreviewItem[][];
}

/** Lote 12 (`window.rs`). */
export interface WindowEntry {
  label: string;
  title: string;
}

/** Documentos entregues a esta janela, com o estado da interface deles (`tabs/transfer.ts`). */
export interface Incoming {
  infos: DocInfo[];
  state: string;
}

/** Eventos do Lote 12, mandados só à janela de destino (menos `WINDOWS_CHANGED_EVENT`: a lista nova, a todas). */
export const DOCS_INCOMING_EVENT = "docs-incoming";
export const MERGE_REQUEST_EVENT = "merge-request";
export const CONFIRM_CLOSE_EVENT = "confirm-close";
export const QUIT_CANCELLED_EVENT = "quit-cancelled";
export const CLOSE_WINDOW_EVENT = "close-window";
export const ACTIVATE_DOCUMENT_EVENT = "activate-document";
export const WINDOWS_CHANGED_EVENT = "windows-changed";
export const PING_WINDOW_EVENT = "ping-window";
export const MERGE_DECLINED_EVENT = "merge-declined";

/** Resposta de `confirm_quit`. `opening` e `unresponsive` vêm antes de perguntar a qualquer janela. */
export type QuitOutcome =
  | { kind: "agreed" }
  | { kind: "cancelled" }
  | { kind: "opening"; title: string }
  | { kind: "unresponsive"; label: string; title: string };

/** Instância única: outra execução do app pediu arquivos a esta janela (`take_open_requests`). */
export const OPEN_REQUEST_EVENT = "open-request";

/** Importar do Scanner. */
export interface ScanDevice {
  name: string;
  label: string;
}
export type ScanKind = "color" | "gray" | "lineart";
export interface ScanOptions {
  modes: ScanKind[];
  resolutions: number[];
  resolution: number;
}
