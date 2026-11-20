import type { Rect } from "../ipc/types";

export type SelectionTool = "rect" | "ellipse" | "lasso" | "smartLasso" | "instantAlpha";

/** Transformação imagem→tela: `tela = pan + imagem * scale`. */
export interface ViewTransform {
  scale: number;
  panX: number;
  panY: number;
}

export const toScreen = (v: ViewTransform, ix: number, iy: number): [number, number] => [
  v.panX + ix * v.scale,
  v.panY + iy * v.scale,
];

export const toImage = (v: ViewTransform, sx: number, sy: number): [number, number] => [
  (sx - v.panX) / v.scale,
  (sy - v.panY) / v.scale,
];

/** Retângulo (inteiro, dentro da imagem) entre dois pontos; `square` força lados iguais. */
export function rectFromPoints(
  a: [number, number],
  b: [number, number],
  w: number,
  h: number,
  square = false,
): Rect {
  let [bx, by] = b;
  if (square) {
    const side = Math.max(Math.abs(bx - a[0]), Math.abs(by - a[1]));
    bx = a[0] + Math.sign(bx - a[0] || 1) * side;
    by = a[1] + Math.sign(by - a[1] || 1) * side;
  }
  const clampX = (v: number) => Math.min(w, Math.max(0, Math.round(v)));
  const clampY = (v: number) => Math.min(h, Math.max(0, Math.round(v)));
  const [x0, x1] = [clampX(Math.min(a[0], bx)), clampX(Math.max(a[0], bx))];
  const [y0, y1] = [clampY(Math.min(a[1], by)), clampY(Math.max(a[1], by))];
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_POS: Record<Handle, [number, number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};
export const HANDLES = Object.keys(HANDLE_POS) as Handle[];
const HANDLE_HIT_PX = 7;

export function handlePosition(r: Rect, v: ViewTransform, h: Handle): [number, number] {
  const [fx, fy] = HANDLE_POS[h];
  return toScreen(v, r.x + r.w * fx, r.y + r.h * fy);
}

/** Alça sob o ponto de tela, ou `null`. */
export function hitHandle(r: Rect, v: ViewTransform, sx: number, sy: number): Handle | null {
  for (const h of HANDLES) {
    const [hx, hy] = handlePosition(r, v, h);
    if (Math.abs(sx - hx) <= HANDLE_HIT_PX && Math.abs(sy - hy) <= HANDLE_HIT_PX) return h;
  }
  return null;
}

/** Move a alça `h` por `(dx, dy)` (px da imagem); mínimo de 1 px e dentro da imagem. */
export function resizeRect(r: Rect, h: Handle, dx: number, dy: number, w: number, hgt: number): Rect {
  let [x0, y0, x1, y1] = [r.x, r.y, r.x + r.w, r.y + r.h];
  if (h.includes("w")) x0 = Math.min(Math.max(0, x0 + dx), x1 - 1);
  if (h.includes("e")) x1 = Math.max(Math.min(w, x1 + dx), x0 + 1);
  if (h.includes("n")) y0 = Math.min(Math.max(0, y0 + dy), y1 - 1);
  if (h.includes("s")) y1 = Math.max(Math.min(hgt, y1 + dy), y0 + 1);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

const TOLERANCE_MAX_DRAG_PX = 300;

/** Distância arrastada (0–300 px) → tolerância (0–1). */
export const toleranceFromDistance = (px: number) => Math.min(1, Math.max(0, px / TOLERANCE_MAX_DRAG_PX));

/** No máximo uma chamada em andamento: pedidos que chegam nesse meio-tempo se reduzem ao
 *  último, disparado quando a atual termina. `onDone(resultado, arg, ultimo)`: `ultimo` é
 *  `true` quando não há pedido pendente (ou seja, o resultado é o mais recente). */
export function latestOnly<A, R>(fn: (a: A) => Promise<R>, onDone: (r: R, a: A, last: boolean) => void) {
  let busy = false;
  let next: { a: A } | null = null;
  const run = async (a: A): Promise<void> => {
    busy = true;
    try {
      onDone(await fn(a), a, next === null);
    } catch {
      // prévia: uma falha não deve impedir o próximo pedido
    } finally {
      busy = false;
      const pending = next;
      next = null;
      if (pending) void run(pending.a);
    }
  };
  return (a: A) => {
    if (busy) next = { a };
    else void run(a);
  };
}

/** Formatos sem canal alfa: o resultado do Alfa Instantâneo vira PNG ao salvar/exportar. */
export const FORMATS_WITHOUT_ALPHA = new Set(["jpeg", "bmp", "raw"]);
