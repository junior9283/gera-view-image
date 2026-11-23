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
  type Point,
  type Seg,
} from "../model";
import { snap45 } from "./create";

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

/** Shift mantém a proporção (linhas: 45°); Alt redimensiona a partir do centro. */
export interface Mods { shift: boolean; alt: boolean }
const NO_MODS: Mods = { shift: false, alt: false };

/** Um eixo da caixa: ponto fixo, quanto a alça se afastou dele (com sinal) e o tamanho de origem. */
interface Axis { moves: boolean; anchor: number; size: number; from: number; mid: number }

function axis(at: number, len: number, start: boolean, end: boolean, p: number, alt: boolean): Axis {
  const mid = at + len / 2;
  const anchor = alt ? mid : start ? at + len : at;
  return { moves: start || end, anchor, size: p - anchor, from: alt ? len / 2 : len, mid };
}

/** Início e comprimento do eixo com o afastamento `size` (que é a metade, se `alt`). */
const span = (a: Axis, size: number, alt: boolean): [number, number] =>
  alt ? [a.mid - Math.abs(size), Math.abs(size) * 2] : [Math.min(a.anchor, a.anchor + size), Math.abs(size)];

function resizeBox(b: Box, h: BoxHandle, x: number, y: number, { shift, alt }: Mods): Box {
  const ax = axis(b.x, b.w, h.includes("w"), h.includes("e"), x, alt);
  const ay = axis(b.y, b.h, h.includes("n"), h.includes("s"), y, alt);
  // Sem largura ou altura não há proporção a manter.
  const k = shift && b.w && b.h ? Math.max(...[ax, ay].map((a) => (a.moves ? Math.abs(a.size) / a.from : 0))) : null;
  const solve = (a: Axis, start: boolean, at: number, len: number): [number, number] => {
    if (!a.moves) return k === null ? [at, len] : [a.mid - (len * k) / 2, len * k];
    return span(a, k === null ? a.size : (Math.sign(a.size) || (start ? -1 : 1)) * a.from * k, alt);
  };
  const [nx, w] = solve(ax, h.includes("w"), b.x, b.w);
  const [ny, hh] = solve(ay, h.includes("n"), b.y, b.h);
  return { x: nx, y: ny, w, h: hh };
}

/** A ponta `h` da linha em `to`; com Alt, a outra espelha em torno do centro. */
function dragEnd(g: Seg, h: "p1" | "p2", to: Point, { shift, alt }: Mods): Seg {
  const other: Point = h === "p1" ? [g.x2, g.y2] : [g.x1, g.y1];
  const mid: Point = [(g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2];
  const [x, y] = shift ? snap45(alt ? mid : other, to) : to;
  const [ox, oy] = alt ? [2 * mid[0] - x, 2 * mid[1] - y] : other;
  return h === "p1" ? { x1: x, y1: y, x2: ox, y2: oy } : { x1: ox, y1: oy, x2: x, y2: y };
}

/**
 * Nova anotação ao arrastar a alça `h` de `orig` até (x, y). `start` é onde o arrasto
 * começou (as alças de contagem e aumento andam pelo deslocamento, não pela posição).
 */
export function dragHandle(
  orig: Annotation, h: HandleId, x: number, y: number, start: [number, number], scale: number, mods: Mods = NO_MODS,
): Annotation {
  const dx = (x - start[0]) * scale;
  const dy = (y - start[1]) * scale;
  switch (h) {
    case "p1":
    case "p2":
      if (orig.kind !== "line" && orig.kind !== "arrow") return orig;
      return { ...orig, geom: dragEnd(orig.geom, h, [x, y], mods) };
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
      return resizeTo(orig, resizeBox(orig.kind === "bubble" ? normBox(orig.geom) : bounds(orig), h, x, y, mods));
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
