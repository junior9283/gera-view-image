import type { Rect } from "../ipc/types";

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Estado da visualização em px CSS: a origem da imagem fica em (panX, panY) e 1 px da imagem
 * ocupa `scale` px na tela. `fit` e `actual` se mantêm ao redimensionar; `free` é zoom manual.
 */
export interface ViewState {
  scale: number;
  panX: number;
  panY: number;
  mode: "fit" | "actual" | "free";
}

export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 32];
export const MIN_SCALE = ZOOM_STEPS[0];
export const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const EPS = 1e-9;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Escala para a imagem caber na view; nunca amplia, salvo `allowUpscale`. */
export function fitScale(img: Size, view: Size, allowUpscale = false): number {
  if (img.w <= 0 || img.h <= 0) return 1;
  const s = Math.min(view.w / img.w, view.h / img.h);
  return allowUpscale ? s : Math.min(1, s);
}

/** Aplica `factor` mantendo fixo o ponto da imagem sob `anchor` (px da view). */
export function zoomAt(state: ViewState, factor: number, anchor: Point): ViewState {
  const scale = clampScale(state.scale * factor);
  const k = scale / state.scale;
  return {
    scale,
    panX: anchor.x - (anchor.x - state.panX) * k,
    panY: anchor.y - (anchor.y - state.panY) * k,
    mode: "free",
  };
}

const clampAxis = (pan: number, img: number, view: number) =>
  img <= view ? (view - img) / 2 : Math.min(0, Math.max(view - img, pan));

/** Centraliza o eixo em que a imagem é menor que a view e não deixa a maior sair dela. */
export function clampPan(state: ViewState, img: Size, view: Size): ViewState {
  return {
    ...state,
    panX: clampAxis(state.panX, img.w * state.scale, view.w),
    panY: clampAxis(state.panY, img.h * state.scale, view.h),
  };
}

/** Estado inicial de `fit` (ajustar à janela) ou `actual` (100 %), centralizado. */
export function fitState(img: Size, view: Size, mode: "fit" | "actual"): ViewState {
  const scale = mode === "fit" ? fitScale(img, view) : 1;
  return clampPan({ scale, panX: 0, panY: 0, mode }, img, view);
}

/** Próximo degrau de `ZOOM_STEPS` na direção `dir`, parando nas pontas. */
export function nextStep(scale: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > scale + EPS) ?? MAX_SCALE;
  return [...ZOOM_STEPS].reverse().find((s) => s < scale - EPS) ?? MIN_SCALE;
}

/** Retângulo da imagem (px inteiros da imagem) visível na view. */
export function visibleRegion(state: ViewState, img: Size, view: Size): Rect {
  const x = Math.max(0, Math.floor(-state.panX / state.scale));
  const y = Math.max(0, Math.floor(-state.panY / state.scale));
  const x1 = Math.min(img.w, Math.ceil((view.w - state.panX) / state.scale));
  const y1 = Math.min(img.h, Math.ceil((view.h - state.panY) / state.scale));
  return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}
