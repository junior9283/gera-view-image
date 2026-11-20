// Espelho de `src-tauri/src/doc/model.rs`. Enums com dados usam `{ type, data }`.

export type DocId = number;

export type SourceFormat =
  | "jpeg" | "png" | "gif" | "bmp" | "tiff" | "webp" | "heic"
  | "avif" | "ico" | "svg" | "psd" | "tga" | "raw";

export type ErrorCode = "not_found" | "unsupported" | "corrupt" | "io" | "permission" | "changed_on_disk";

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
  | { type: "crop"; data: Rect }
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
