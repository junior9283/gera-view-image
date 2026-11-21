// Espelho de `src-tauri/src/doc/model.rs`. Enums com dados usam `{ type, data }`.

export type DocId = number;

export type SourceFormat =
  | "jpeg" | "png" | "gif" | "bmp" | "tiff" | "webp" | "heic"
  | "avif" | "ico" | "svg" | "psd" | "tga" | "raw";

export type ErrorCode =
  | "not_found"
  | "unsupported"
  | "corrupt"
  | "io"
  | "permission"
  | "changed_on_disk"
  | "heic_decoder_missing"
  | "empty_selection"
  | "clipboard_empty";

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
  | { type: "composite"; data: { png: Uint8Array | number[] } };

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
}

// ---------- Arquivo (Task 11): espelho de `image/encode.rs` e `doc/file.rs` ----------

export type ExportFormat = "jpeg" | "png" | "tiff" | "heic" | "webp" | "avif" | "jp2" | "exr" | "bmp";

export interface ExportOptions {
  format: ExportFormat;
  /** 1..100; `null`: JPEG 90, WebP sem perdas, AVIF 80. */
  quality: number | null;
  alpha: boolean;
  depth16: boolean;
  stripMetadata: boolean;
  resize: [number, number] | null;
}

export type SaveOutcome = { type: "saved"; data: DocInfo } | { type: "needsExport" };

export type RevertTarget = "lastSaved" | "original";

export type CaptureMode = "selection" | "window" | "screen";

/** Evento do vigia: o arquivo do documento mudou (ou sumiu) fora do app. */
export const DOC_CHANGED_ON_DISK_EVENT = "doc-changed-on-disk";
export interface DiskChanged { id: DocId; removed: boolean }
