// Esboço: reconhece formas em um traço livre (linha, seta, retângulo, oval, estrela, balão).
// Se nada bater, quem chama mantém o traço como mão livre.
import { simplifyPath } from "../select/lasso";
import { boxOf, clamp, distToSegment, type Box, type Point, type Seg } from "./model";

export type Recognized =
  | { kind: "line" | "arrow"; geom: Seg }
  | { kind: "rect" | "oval"; geom: Box }
  | { kind: "star"; geom: Box & { points: number } }
  | { kind: "bubble"; geom: Box & { tail: { x: number; y: number } } };

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const pathLength = (p: readonly Point[]) => p.reduce((s, q, i) => (i ? s + dist(p[i - 1], q) : 0), 0);

/** Reamostra o traço em `n` pontos equidistantes (a densidade do mouse não pesa nas médias). */
function resample(p: readonly Point[], n: number): Point[] {
  const total = pathLength(p);
  if (total === 0) return [p[0]];
  const step = total / (n - 1);
  const out: Point[] = [p[0]];
  let acc = 0;
  let prev = p[0];
  for (let i = 1; i < p.length && out.length < n; ) {
    const d = dist(prev, p[i]);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      prev = [prev[0] + t * (p[i][0] - prev[0]), prev[1] + t * (p[i][1] - prev[1])];
      out.push(prev);
      acc = 0;
    } else {
      acc += d;
      prev = p[i];
      i++;
    }
  }
  while (out.length < n) out.push(p[p.length - 1]);
  return out;
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);

const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

/** Erro médio de um ajuste de elipse inscrita na caixa (0 = elipse perfeita). */
function ellipseError(p: readonly Point[], b: Box): number {
  const [cx, cy, a, r] = [b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2];
  return mean(p.map(([x, y]) => Math.abs(Math.hypot((x - cx) / a, (y - cy) / r) - 1)));
}

/** Distância média dos pontos à borda mais próxima da caixa, relativa ao menor lado. */
function rectError(p: readonly Point[], b: Box): number {
  const edge = ([x, y]: Point) => Math.min(Math.abs(x - b.x), Math.abs(x - b.x - b.w), Math.abs(y - b.y), Math.abs(y - b.y - b.h));
  return mean(p.map(edge)) / Math.max(1, Math.min(b.w, b.h));
}

function recognizeOpen(p: readonly Point[], length: number): Recognized | null {
  const s = p[0];
  const e = p[p.length - 1];
  const gap = dist(s, e);
  const maxDev = Math.max(...p.map(([x, y]) => distToSegment(x, y, s[0], s[1], e[0], e[1])));
  if (gap / length > 0.95 && maxDev < 0.06 * gap) return { kind: "line", geom: { x1: s[0], y1: s[1], x2: e[0], y2: e[1] } };

  // Seta: haste reta até a ponta (ponto mais distante do início) e um "V" curto atrás dela.
  let tip = 0;
  p.forEach((q, i) => dist(s, q) > dist(s, p[tip]) && (tip = i));
  const t = p[tip];
  const shaft = dist(s, t);
  if (tip === p.length - 1 || shaft < 20) return null;
  const shaftPts = p.slice(0, tip + 1);
  if (shaft / pathLength(shaftPts) < 0.95) return null;
  const head = p.slice(tip);
  const headLen = pathLength(head);
  const [ux, uy] = [(t[0] - s[0]) / shaft, (t[1] - s[1]) / shaft];
  const behind = head.every(([x, y]) => (x - t[0]) * ux + (y - t[1]) * uy <= 0.05 * shaft);
  const near = head.every((q) => dist(q, t) <= 0.4 * shaft);
  const spread = Math.max(...head.map(([x, y]) => Math.abs((x - t[0]) * -uy + (y - t[1]) * ux)));
  if (headLen > 0.1 * shaft && headLen < shaft && behind && near && spread > 0.04 * shaft) {
    return { kind: "arrow", geom: { x1: s[0], y1: s[1], x2: t[0], y2: t[1] } };
  }
  return null;
}

function recognizeStar(p: readonly Point[], b: Box): Recognized | null {
  const diag = Math.hypot(b.w, b.h);
  const v = simplifyPath([...p], 0.04 * diag).slice(0, -1); // o último repete o primeiro (traço fechado)
  if (v.length < 6 || v.length > 40 || v.length % 2) return null;
  const c = mean(v.map((q) => q[0]));
  const d = mean(v.map((q) => q[1]));
  const radii = v.map(([x, y]) => Math.hypot(x - c, y - d));
  // Começa por uma ponta externa e exige alternância externo/interno.
  const start = radii[0] > radii[1] ? 0 : 1;
  const outer = radii.filter((_, i) => (i + start) % 2 === 0);
  const inner = radii.filter((_, i) => (i + start) % 2 === 1);
  if (Math.min(...outer) < 1.3 * Math.max(...inner)) return null;
  const cv = (r: number[]) => Math.sqrt(mean(r.map((x) => (x - mean(r)) ** 2))) / mean(r);
  if (cv(outer) > 0.2 || cv(inner) > 0.3) return null;
  return { kind: "star", geom: { ...round(b), points: clamp(v.length / 2, 3, 20) } };
}

/** `p` reamostrado para as médias; a ponta da cauda sai do traço `orig` (a reamostragem a arredonda). */
function recognizeBubble(p: readonly Point[], orig: readonly Point[]): Recognized | null {
  const c: Point = [mean(p.map((q) => q[0])), mean(p.map((q) => q[1]))];
  const t = orig.reduce((best, q) => (dist(q, c) > dist(best, c) ? q : best));
  const reach = dist(t, c);
  // Corpo: os pontos longe da ponta da cauda.
  const body = p.filter((q) => dist(q, t) > 0.6 * reach);
  if (body.length < p.length * 0.6) return null;
  const b = boxOf(body);
  if (b.w < 8 || b.h < 8) return null;
  const err = ellipseError(body, b);
  const rect = rectError(body, b) < 0.06;
  const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
  const out = Math.hypot((t[0] - cx) / (b.w / 2), (t[1] - cy) / (b.h / 2));
  if ((err < 0.12 || rect) && out > 1.3) {
    return { kind: "bubble", geom: { ...round(b), tail: { x: Math.round(t[0]), y: Math.round(t[1]) } } };
  }
  return null;
}

export function recognize(points: Point[]): Recognized | null {
  if (points.length < 3) return null;
  const length = pathLength(points);
  if (length < 8) return null;
  const b = boxOf(points);
  const diag = Math.hypot(b.w, b.h);
  const gap = dist(points[0], points[points.length - 1]);
  const closed = gap <= 0.2 * length && gap <= 0.3 * diag;
  if (!closed) return recognizeOpen(points, length);

  const p = resample(points, 96);
  if (b.w < 6 || b.h < 6) return null;
  if (ellipseError(p, b) < 0.08) return { kind: "oval", geom: round(b) };
  if (rectError(p, b) < 0.05) return { kind: "rect", geom: round(b) };
  return recognizeStar(p, b) ?? recognizeBubble(p, points);
}
