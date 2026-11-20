import { invoke } from "@tauri-apps/api/core";
import type { ColorAdjust, DocId, DocInfo, Histogram, Mask, Op, Rect, ViewBuffer } from "./types";

/** Lê o formato de `render_view`/`thumbnail`: `u32 LE w`, `u32 LE h`, RGBA. */
export function decodeViewBuffer(raw: ArrayBuffer | Uint8Array): ViewBuffer {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 8) throw new Error("buffer de prévia sem cabeçalho");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  const len = width * height * 4;
  if (bytes.byteLength < 8 + len) throw new Error("buffer de prévia truncado");
  // O IPC do Tauri entrega ArrayBuffer comum (nunca SharedArrayBuffer).
  return { width, height, data: new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset + 8, len) };
}

export const openDocuments = (paths: string[]) => invoke<DocInfo[]>("open_documents", { paths });

/** Documentos de `argv[1..]`, já abertos pelo Rust durante a inicialização. */
export const startupDocuments = () => invoke<DocInfo[]>("startup_documents");

export const closeDocument = (id: DocId) => invoke<void>("close_document", { id });

export const folderImages = (path: string) => invoke<string[]>("folder_images", { path });

export const renderView = async (id: DocId, frame: number, maxW: number, maxH: number, region: Rect | null = null) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("render_view", { id, frame, maxW, maxH, region }));

export const thumbnail = async (id: DocId, frame: number, size: number) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("thumbnail", { id, frame, size }));

/** `JSON.stringify(Uint8Array)` vira objeto; os bytes do PNG precisam ir como lista. */
const toWire = (op: Op): Op =>
  op.type === "composite" && op.data.png instanceof Uint8Array ? { ...op, data: { png: Array.from(op.data.png) } } : op;

export const applyOp = (id: DocId, op: Op) => invoke<DocInfo>("apply_op", { id, op: toWire(op) });

export const undo = (id: DocId) => invoke<DocInfo>("undo", { id });

export const redo = (id: DocId) => invoke<DocInfo>("redo", { id });

/** Alfa Instantâneo: máscara contígua à cor do pixel (x, y); tolerância 0..1. */
export const instantAlpha = (id: DocId, x: number, y: number, tolerance: number) =>
  invoke<Mask>("instant_alpha", { id, x, y, tolerance });

/** Laço magnético: devolve o caminho colado nas bordas. */
export const snapLasso = (id: DocId, points: [number, number][]) =>
  invoke<[number, number][]>("snap_lasso", { id, points });

/** Copia a região (ou a imagem toda, sem máscara) para a área de transferência como PNG. */
export const copyRegion = (id: DocId, mask: Mask | null) => invoke<void>("copy_region", { id, mask });

/** Prévia de um ajuste de cor em resolução reduzida; não altera o documento. */
export const previewAdjust = async (id: DocId, adjust: ColorAdjust, maxW: number, maxH: number) =>
  decodeViewBuffer(await invoke<ArrayBuffer>("preview_adjust", { id, adjust, maxW, maxH }));

export const histogram = (id: DocId) => invoke<Histogram>("histogram", { id });

export const autoLevels = (id: DocId) => invoke<ColorAdjust>("auto_levels", { id });
