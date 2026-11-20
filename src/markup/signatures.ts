// Assinaturas salvas (plugin-store, `signatures.json`) e sua criação: desenho suavizado
// (Catmull-Rom) ou importação de uma imagem aberta, sem o fundo claro (Alfa Instantâneo).
import { useSyncExternalStore } from "react";
import type { Store } from "@tauri-apps/plugin-store";
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { rasterize } from "../select/lasso";
import { useDocs } from "../store/docs";
import { newId, type Box, type Point } from "./model";

export interface Signature {
  id: string;
  /** PNG em base64 (sem o prefixo `data:`). */
  png: string;
}

export const MAX_SIGNATURES = 10;
const FILE = "signatures.json";
const KEY = "signatures";
/** Tolerância do Alfa Instantâneo para tirar o fundo claro da assinatura importada. */
export const IMPORT_TOLERANCE = 0.15;
/** Lado maior da assinatura guardada (px). */
const MAX_SIDE = 800;
/** Acima disto a imagem é grande demais para importar como assinatura. */
const MAX_IMPORT_PIXELS = 40e6;

export const signatureSrc = (s: Signature) => `data:image/png;base64,${s.png}`;

let list: Signature[] = [];
let store: Store | null = null;
let loading: Promise<Signature[]> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const valid = (v: unknown): v is Signature =>
  !!v && typeof v === "object" && typeof (v as Signature).id === "string" && typeof (v as Signature).png === "string";

export function loadSignatures(): Promise<Signature[]> {
  return (loading ??= (async () => {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      store = await load(FILE, { defaults: {}, autoSave: false });
      const raw = await store.get<unknown[]>(KEY);
      list = Array.isArray(raw) ? raw.filter(valid).slice(0, MAX_SIGNATURES) : [];
    } catch {
      store = null; // fora do Tauri: só em memória
    }
    emit();
    return list;
  })());
}

async function persist(): Promise<void> {
  emit();
  if (!store) return;
  await store.set(KEY, list);
  await store.save();
}

export async function addSignature(png: string): Promise<Signature> {
  await loadSignatures();
  const s = { id: newId(), png };
  list = [s, ...list].slice(0, MAX_SIGNATURES);
  await persist();
  return s;
}

export async function removeSignature(id: string): Promise<void> {
  await loadSignatures();
  list = list.filter((s) => s.id !== id);
  await persist();
}

export const getSignatures = () => list;

export function useSignatures(): Signature[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => list,
  );
}

// ---- desenho ----

/** Spline de Catmull-Rom pelos pontos (`segments` pontos por trecho; passa pelos de controle). */
export function catmullRom(pts: readonly Point[], segments = 8): Point[] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const out: Point[] = [];
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < segments; k++) {
      const t = k / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const last = pts[pts.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

const base64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/** Traços do painel → PNG (base64) recortado na tinta, com margem. */
export function strokesToPng(strokes: readonly Point[][], color: string, width: number): string | null {
  const all = strokes.flat();
  if (!all.length) return null;
  const pad = width * 2;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs) - pad, Math.min(...ys) - pad];
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(Math.max(...xs) + pad - x0);
  cv.height = Math.ceil(Math.max(...ys) + pad - y0);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.translate(-x0, -y0);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    const p = catmullRom(s);
    ctx.beginPath();
    if (p.length === 1) ctx.arc(p[0][0], p[0][1], width / 2, 0, Math.PI * 2);
    else p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (p.length === 1) ctx.fill();
    else ctx.stroke();
  }
  return base64(cv.toDataURL("image/png"));
}

// ---- importação ----

const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Cantos claros (sementes do Alfa Instantâneo), na ordem: ↖ ↗ ↙ ↘. */
export function lightCorners(d: Uint8ClampedArray, w: number, h: number, min = 160): [number, number][] {
  const corners: [number, number][] = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  return corners.filter(([x, y]) => lum(d, (y * w + x) * 4) >= min);
}

/** Zera o alfa onde a cobertura da máscara é 1. */
export function clearMask(d: Uint8ClampedArray, cov: Uint8Array): void {
  for (let i = 0; i < cov.length; i++) if (cov[i]) d[i * 4 + 3] = 0;
}

/** Caixa dos pixels com alfa > 0. */
export function alphaBounds(d: Uint8ClampedArray, w: number, h: number): Box | null {
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Cria uma assinatura a partir de um documento aberto: o Alfa Instantâneo (tolerância 0.15),
 * semeado nos cantos claros, tira o fundo; o resultado é recortado na tinta.
 */
export async function importSignature(id: DocId): Promise<Signature | null> {
  const doc = useDocs.getState().docs.find((d) => d.id === id);
  if (!doc || doc.error || doc.width * doc.height > MAX_IMPORT_PIXELS) return null;
  const { width: w, height: h } = doc;
  const view = await ipc.renderView(id, 0, w, h);
  if (view.width !== w || view.height !== h) return null;
  const data = new Uint8ClampedArray(view.data);
  const masks = await Promise.all(lightCorners(data, w, h).map(([x, y]) => ipc.instantAlpha(id, x, y, IMPORT_TOLERANCE)));
  for (const m of masks) clearMask(data, rasterize(m, w, h));
  const b = alphaBounds(data, w, h);
  if (!b) return null;
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  full.getContext("2d")?.putImageData(new ImageData(data, w, h), 0, 0);
  const k = Math.min(1, MAX_SIDE / Math.max(b.w, b.h));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(b.w * k));
  out.height = Math.max(1, Math.round(b.h * k));
  out.getContext("2d")?.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, out.width, out.height);
  return addSignature(base64(out.toDataURL("image/png")));
}

/** Só para testes. */
export function resetSignaturesForTests(): void {
  list = [];
  store = null;
  loading = null;
}
