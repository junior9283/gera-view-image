// Criação de anotações pelas ferramentas da barra (arrasto, traço e clique).
import { DEFAULT_FONT, boxOf, newId, type Annotation, type Point, type Style } from "../model";
import { recognize } from "../sketch";
import type { ShapeTool } from "../store";

/** Abaixo disto (px de tela) o arrasto conta como clique: a forma nasce no tamanho padrão. */
const CLICK_PX = 4;
/** Tamanho padrão (px de tela) da forma criada com um clique. */
const DEFAULT_PX = 120;
const LOUPE_PX = 60;

/**
 * A barra trabalha em px de tela (espessura, tamanho da fonte); a anotação guarda px da
 * imagem. Converte pela escala atual, para a forma nascer com o tamanho que se vê.
 */
export function toImageStyle(s: Style, scale: number): Style {
  const k = 1 / scale;
  const out: Style = { ...s, width: Math.max(0.5, Math.round(s.width * k * 10) / 10) };
  if (s.font) out.font = { ...s.font, size: Math.max(4, Math.round(s.font.size * k * 2) / 2) };
  return out;
}

const box = (a: Point, b: Point) => boxOf([a, b]);

/** `to` preso ao múltiplo de 45° mais próximo a partir de `from` (Shift em linhas). */
export function snap45(from: Point, to: Point): Point {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const turn = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const [ux, uy] = [Math.round(Math.cos((turn * Math.PI) / 4)), Math.round(Math.sin((turn * Math.PI) / 4))];
  // Projeção na direção escolhida (a diagonal tem comprimento √2).
  const k = (dx * ux + dy * uy) / (ux * ux + uy * uy || 1);
  return [from[0] + ux * k, from[1] + uy * k];
}

/** `to` no canto do quadrado com `from` (Shift em formas). */
function squareTo(from: Point, to: Point): Point {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + (Math.sign(dx) || 1) * side, from[1] + (Math.sign(dy) || 1) * side];
}

/** `shift`: lados iguais nas formas, ângulos de 45° nas linhas. */
export function createShape(tool: ShapeTool, a: Point, to: Point, barStyle: Style, scale: number, shift = false): Annotation {
  const b = !shift ? to : tool === "line" || tool === "arrow" ? snap45(a, to) : tool === "loupe" ? to : squareTo(a, to);
  const style = toImageStyle(barStyle, scale);
  const id = newId();
  const click = Math.hypot(b[0] - a[0], b[1] - a[1]) * scale < CLICK_PX;
  const half = DEFAULT_PX / scale / 2;
  const [p, q]: [Point, Point] = click ? [[a[0] - half, a[1] - half], [a[0] + half, a[1] + half]] : [a, b];
  const bx = box(p, q);
  switch (tool) {
    case "line":
    case "arrow": {
      const [s, e]: [Point, Point] = click ? [[a[0] - half, a[1]], [a[0] + half, a[1]]] : [a, b];
      const st = tool === "arrow" && style.arrowEnd === "none" ? { ...style, arrowEnd: "arrow" as const } : style;
      return { id, kind: tool, geom: { x1: s[0], y1: s[1], x2: e[0], y2: e[1] }, style: st };
    }
    case "rect":
    case "oval":
      return { id, kind: tool, geom: bx, style };
    case "roundRect":
      return { id, kind: "roundRect", geom: { ...bx, radius: Math.min(bx.w, bx.h) * 0.2 }, style };
    case "bubble":
      return {
        id,
        kind: "bubble",
        geom: { ...bx, tail: { x: bx.x + bx.w * 0.25, y: bx.y + bx.h * 1.5 } },
        style: { ...style, fill: style.fill ?? "#ffffff" },
      };
    case "star":
      return { id, kind: "star", geom: { ...bx, points: 5 }, style };
    case "polygon":
      return { id, kind: "polygon", geom: { ...bx, sides: 6 }, style };
    case "loupe": {
      const r = click ? LOUPE_PX / scale : Math.hypot(b[0] - a[0], b[1] - a[1]);
      return { id, kind: "loupe", geom: { cx: a[0], cy: a[1], r, zoom: 2 }, style };
    }
    case "highlight":
    case "highlightOval":
      return { id, kind: "highlight", geom: { ...bx, shape: tool === "highlight" ? "rect" : "oval" }, style };
  }
}

/** Traço do Desenho (mão livre) ou do Esboço (tenta reconhecer a forma). */
export function createStroke(points: Point[], barStyle: Style, scale: number, sketch: boolean): Annotation | null {
  if (points.length < 2) return null;
  const style = toImageStyle(barStyle, scale);
  const id = newId();
  const r = sketch ? recognize(points) : null;
  if (!r) return { id, kind: "freehand", geom: { points }, style };
  if (r.kind === "arrow") return { id, ...r, style: { ...style, arrowEnd: style.arrowEnd === "none" ? "arrow" : style.arrowEnd } };
  if (r.kind === "bubble") return { id, ...r, style: { ...style, fill: style.fill ?? "#ffffff" } };
  return { id, ...r, style } as Annotation;
}

export function createText(at: Point, barStyle: Style, scale: number, text: string): Annotation {
  const style = toImageStyle({ ...barStyle, font: barStyle.font ?? DEFAULT_FONT }, scale);
  const size = style.font!.size;
  return { id: newId(), kind: "text", geom: { x: at[0], y: at[1], w: size * 8, h: size * 1.3, text }, style };
}
