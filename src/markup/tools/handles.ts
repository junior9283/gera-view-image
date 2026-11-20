// Alças de edição das anotações selecionadas (coordenadas da imagem).
import {
  COUNT_MAX,
  COUNT_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  bounds,
  clamp,
  normBox,
  type Annotation,
  type Box,
} from "../model";

export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type HandleId = BoxHandle | "p1" | "p2" | "tail" | "count" | "zoom" | "radius";
/** `green` = aumento da lupa, `blue` = raio da lupa, `yellow` = forma (cauda, pontas, lados). */
export type HandleColor = "white" | "green" | "blue" | "yellow";

export interface Handle { id: HandleId; x: number; y: number; color: HandleColor }

const BOX: Record<BoxHandle, [number, number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};
const BOX_IDS = Object.keys(BOX) as BoxHandle[];

/** Distância (px de tela) entre a alça de pontas/lados e a caixa. */
const COUNT_GAP = 16;
/** Arrasto (px de tela) para mudar uma ponta/lado e 1× de aumento. */
const COUNT_STEP = 15;
const ZOOM_STEP = 40;

const boxHandles = (b: Box): Handle[] =>
  BOX_IDS.map((id) => ({ id, x: b.x + BOX[id][0] * b.w, y: b.y + BOX[id][1] * b.h, color: "white" }));

/** Alças da anotação; `scale` (tela/imagem) afasta as alças extras a uma distância fixa na tela. */
export function handlesFor(a: Annotation, scale: number): Handle[] {
  switch (a.kind) {
    case "line":
    case "arrow":
      return [
        { id: "p1", x: a.geom.x1, y: a.geom.y1, color: "white" },
        { id: "p2", x: a.geom.x2, y: a.geom.y2, color: "white" },
      ];
    case "loupe": {
      const { cx, cy, r } = a.geom;
      const d = r / Math.SQRT2;
      return [
        { id: "zoom", x: cx + d, y: cy - d, color: "green" },
        { id: "radius", x: cx + d, y: cy + d, color: "blue" },
      ];
    }
    case "bubble":
      return [...boxHandles(normBox(a.geom)), { id: "tail", x: a.geom.tail.x, y: a.geom.tail.y, color: "yellow" }];
    case "star":
    case "polygon": {
      const b = normBox(a.geom);
      return [...boxHandles(b), { id: "count", x: b.x + b.w + COUNT_GAP / scale, y: b.y, color: "yellow" }];
    }
    default:
      return boxHandles(bounds(a));
  }
}

/** Alça sob o ponto de tela (`tol` em px de tela). */
export function hitHandle(hs: Handle[], x: number, y: number, scale: number, tol = 7): Handle | null {
  return hs.find((h) => Math.abs(h.x - x) * scale <= tol && Math.abs(h.y - y) * scale <= tol) ?? null;
}

function resizeBox(b: Box, h: BoxHandle, x: number, y: number): Box {
  let [x0, y0, x1, y1] = [b.x, b.y, b.x + b.w, b.y + b.h];
  if (h.includes("w")) x0 = x;
  if (h.includes("e")) x1 = x;
  if (h.includes("n")) y0 = y;
  if (h.includes("s")) y1 = y;
  return normBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/**
 * Nova anotação ao arrastar a alça `h` de `orig` até (x, y). `start` é onde o arrasto
 * começou (as alças de contagem e aumento andam pelo deslocamento, não pela posição).
 */
export function dragHandle(orig: Annotation, h: HandleId, x: number, y: number, start: [number, number], scale: number): Annotation {
  const dx = (x - start[0]) * scale;
  const dy = (y - start[1]) * scale;
  switch (h) {
    case "p1":
    case "p2":
      if (orig.kind !== "line" && orig.kind !== "arrow") return orig;
      return { ...orig, geom: h === "p1" ? { ...orig.geom, x1: x, y1: y } : { ...orig.geom, x2: x, y2: y } };
    case "tail":
      return orig.kind === "bubble" ? { ...orig, geom: { ...orig.geom, tail: { x, y } } } : orig;
    case "count": {
      const step = Math.round(dx / COUNT_STEP);
      if (orig.kind === "star") return { ...orig, geom: { ...orig.geom, points: clamp(orig.geom.points + step, COUNT_MIN, COUNT_MAX) } };
      if (orig.kind === "polygon") return { ...orig, geom: { ...orig.geom, sides: clamp(orig.geom.sides + step, COUNT_MIN, COUNT_MAX) } };
      return orig;
    }
    case "zoom":
      if (orig.kind !== "loupe") return orig;
      return { ...orig, geom: { ...orig.geom, zoom: Math.round(clamp(orig.geom.zoom + (dx - dy) / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX) * 10) / 10 } };
    case "radius":
      if (orig.kind !== "loupe") return orig;
      return { ...orig, geom: { ...orig.geom, r: Math.max(4 / scale, Math.hypot(x - orig.geom.cx, y - orig.geom.cy)) } };
    default:
      // O balão redimensiona só o corpo (a cauda tem alça própria).
      return resizeTo(orig, resizeBox(orig.kind === "bubble" ? normBox(orig.geom) : bounds(orig), h, x, y));
  }
}

/** Encaixa a anotação na caixa `nb` (mão livre e linhas escalam os pontos). */
export function resizeTo(a: Annotation, nb: Box): Annotation {
  const ob = bounds(a);
  const sx = ob.w ? nb.w / ob.w : 1;
  const sy = ob.h ? nb.h / ob.h : 1;
  const mx = (x: number) => nb.x + (x - ob.x) * sx;
  const my = (y: number) => nb.y + (y - ob.y) * sy;
  switch (a.kind) {
    case "line":
    case "arrow":
      return { ...a, geom: { x1: mx(a.geom.x1), y1: my(a.geom.y1), x2: mx(a.geom.x2), y2: my(a.geom.y2) } };
    case "freehand":
      return { ...a, geom: { points: a.geom.points.map(([x, y]) => [mx(x), my(y)]) } };
    case "loupe":
      return a;
    default:
      return { ...a, geom: { ...a.geom, ...nb } } as Annotation;
  }
}
