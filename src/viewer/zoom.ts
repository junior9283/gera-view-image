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
 *
 * O zoom mostrado ao usuário é `scale * k`, com `k` = `zoomUnit()` (o `devicePixelRatio`, ou a razão
 * entre as resoluções do documento e da tela): 100 % é o Tamanho Real escolhido nas Preferências. Degraus e limites valem no zoom mostrado.
 */
export interface ViewState {
  scale: number;
  panX: number;
  panY: number;
  mode: "fit" | "actual" | "free";
}

export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 32];
const MIN_SCALE = ZOOM_STEPS[0];
const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const EPS = 1e-9;
const clampScale = (s: number, k: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * k)) / k;

/** Escala para a imagem caber na view; nunca passa do Tamanho Real, salvo `allowUpscale`. */
export function fitScale(img: Size, view: Size, allowUpscale = false, k = 1): number {
  if (img.w <= 0 || img.h <= 0) return 1 / k;
  const s = Math.min(view.w / img.w, view.h / img.h);
  return allowUpscale ? s : Math.min(1 / k, s);
}

/** Aplica `factor` mantendo fixo o ponto da imagem sob `anchor` (px da view). */
export function zoomAt(state: ViewState, factor: number, anchor: Point, k = 1): ViewState {
  const scale = clampScale(state.scale * factor, k);
  const r = scale / state.scale;
  return {
    scale,
    panX: anchor.x - (anchor.x - state.panX) * r,
    panY: anchor.y - (anchor.y - state.panY) * r,
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
export function fitState(img: Size, view: Size, mode: "fit" | "actual", k = 1): ViewState {
  const scale = mode === "fit" ? fitScale(img, view, false, k) : 1 / k;
  return clampPan({ scale, panX: 0, panY: 0, mode }, img, view);
}

/** Próximo degrau de `ZOOM_STEPS` na direção `dir`, parando nas pontas. */
export function nextStep(scale: number, dir: 1 | -1, k = 1): number {
  const shown = scale * k;
  if (dir > 0) return (ZOOM_STEPS.find((s) => s > shown + EPS) ?? MAX_SCALE) / k;
  return ([...ZOOM_STEPS].reverse().find((s) => s < shown - EPS) ?? MIN_SCALE) / k;
}

/** Retângulo da imagem (px inteiros da imagem) visível na view. */
export function visibleRegion(state: ViewState, img: Size, view: Size): Rect {
  const x = Math.max(0, Math.floor(-state.panX / state.scale));
  const y = Math.max(0, Math.floor(-state.panY / state.scale));
  const x1 = Math.min(img.w, Math.ceil((view.w - state.panX) / state.scale));
  const y1 = Math.min(img.h, Math.ceil((view.h - state.panY) / state.scale));
  return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}

/** Enquadra o retângulo `r` (px da imagem) centralizado na view, dentro dos limites de escala. */
export function rectState(r: Rect, view: Size, k = 1): ViewState {
  const scale = clampScale(Math.min(view.w / Math.max(1, r.w), view.h / Math.max(1, r.h)), k);
  return {
    scale,
    panX: view.w / 2 - (r.x + r.w / 2) * scale,
    panY: view.h / 2 - (r.y + r.h / 2) * scale,
    mode: "free",
  };
}
