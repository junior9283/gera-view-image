// Modelo vetorial das anotações (Marcação). Coordenadas sempre em pixels da imagem.

export type Point = [number, number];
export type ArrowEnd = "none" | "arrow" | "circle";
export type Dash = "solid" | "dashed" | "dotted";
export type Align = "left" | "center" | "right";

export interface FontStyle {
  family: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: Align;
}

export interface Style {
  stroke: string;
  fill: string | null;
  width: number;
  dash: Dash;
  arrowStart: ArrowEnd;
  arrowEnd: ArrowEnd;
  shadow: boolean;
  font?: FontStyle;
}

/** Alteração de estilo: a fonte pode vir parcial e é mesclada. */
export type StylePatch = Partial<Omit<Style, "font">> & { font?: Partial<FontStyle> };

export interface Box { x: number; y: number; w: number; h: number }
export interface Seg { x1: number; y1: number; x2: number; y2: number }

interface Base { id: string; style: Style }

export type Annotation = Base &
  (
    | { kind: "line" | "arrow"; geom: Seg }
    | { kind: "rect" | "oval"; geom: Box }
    | { kind: "roundRect"; geom: Box & { radius: number } }
    | { kind: "bubble"; geom: Box & { tail: { x: number; y: number } } }
    | { kind: "star"; geom: Box & { points: number } }
    | { kind: "polygon"; geom: Box & { sides: number } }
    | { kind: "freehand"; geom: { points: Point[] } }
    | { kind: "text"; geom: Box & { text: string } }
    | { kind: "loupe"; geom: { cx: number; cy: number; r: number; zoom: number } }
    | { kind: "highlight"; geom: Box & { shape: "rect" | "oval" } }
    | { kind: "signature" | "image"; geom: Box & { src: string } }
  );

export type Kind = Annotation["kind"];
export type Geom<K extends Kind> = Extract<Annotation, { kind: K }>["geom"];

export interface AnnotationDoc { items: Annotation[] }

export const KINDS: readonly Kind[] = [
  "line", "arrow", "rect", "roundRect", "oval", "bubble", "star", "polygon",
  "freehand", "text", "loupe", "highlight", "signature", "image",
];

export const COUNT_MIN = 3;
export const COUNT_MAX = 20;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

export const DEFAULT_FONT: FontStyle = {
  family: "Inter",
  size: 24,
  color: "#000000",
  bold: false,
  italic: false,
  underline: false,
  align: "left",
};

export const DEFAULT_STYLE: Style = {
  stroke: "#ff3b30",
  fill: null,
  width: 3,
  dash: "solid",
  arrowStart: "none",
  arrowEnd: "none",
  shadow: false,
};

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

let seq = 0;
export const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `a${Date.now().toString(36)}${(seq++).toString(36)}`;

const hasBox = (g: object): g is Box => "w" in g && "h" in g;

/** Caixa normalizada (largura/altura positivas). */
export const normBox = (b: Box): Box => ({
  x: Math.min(b.x, b.x + b.w),
  y: Math.min(b.y, b.y + b.h),
  w: Math.abs(b.w),
  h: Math.abs(b.h),
});

export function boxOf(points: readonly Point[]): Box {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return points.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Caixa que envolve a anotação (sem a espessura do traço). */
export function bounds(a: Annotation): Box {
  switch (a.kind) {
    case "line":
    case "arrow":
      return boxOf([[a.geom.x1, a.geom.y1], [a.geom.x2, a.geom.y2]]);
    case "freehand":
      return boxOf(a.geom.points);
    case "loupe": {
      const { cx, cy, r } = a.geom;
      return { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
    }
    case "bubble": {
      const b = normBox(a.geom);
      const { x, y } = a.geom.tail;
      return boxOf([[b.x, b.y], [b.x + b.w, b.y + b.h], [x, y]]);
    }
    default:
      return normBox(a.geom);
  }
}

/** Desloca a anotação (imutável). */
export function translate(a: Annotation, dx: number, dy: number): Annotation {
  const g = a.geom;
  switch (a.kind) {
    case "line":
    case "arrow":
      return { ...a, geom: { x1: a.geom.x1 + dx, y1: a.geom.y1 + dy, x2: a.geom.x2 + dx, y2: a.geom.y2 + dy } };
    case "freehand":
      return { ...a, geom: { points: a.geom.points.map(([x, y]) => [x + dx, y + dy] as Point) } };
    case "loupe":
      return { ...a, geom: { ...a.geom, cx: a.geom.cx + dx, cy: a.geom.cy + dy } };
    case "bubble":
      return { ...a, geom: { ...a.geom, x: a.geom.x + dx, y: a.geom.y + dy, tail: { x: a.geom.tail.x + dx, y: a.geom.tail.y + dy } } };
    default:
      return hasBox(g) ? ({ ...a, geom: { ...g, x: g.x + dx, y: g.y + dy } } as Annotation) : a;
  }
}

const mapSome = (items: Annotation[], ids: readonly string[], f: (a: Annotation) => Annotation) => {
  const set = new Set(ids);
  return items.map((a) => (set.has(a.id) ? f(a) : a));
};

export const moveItems = (items: Annotation[], ids: readonly string[], dx: number, dy: number) =>
  mapSome(items, ids, (a) => translate(a, dx, dy));

export function mergeStyle(s: Style, patch: StylePatch): Style {
  const { font, ...rest } = patch;
  const out: Style = { ...s, ...rest };
  if (font) out.font = { ...DEFAULT_FONT, ...s.font, ...font };
  return out;
}

export const restyle = (items: Annotation[], ids: readonly string[], patch: StylePatch) =>
  mapSome(items, ids, (a) => ({ ...a, style: mergeStyle(a.style, patch) }));

// ---- serialização ----

export const serialize = (doc: AnnotationDoc): string => JSON.stringify({ version: 1, items: doc.items });

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const nums = (o: Record<string, unknown>, ...keys: string[]) => keys.every((k) => isNum(o[k]));

function validGeom(kind: Kind, g: Record<string, unknown>): boolean {
  switch (kind) {
    case "line":
    case "arrow":
      return nums(g, "x1", "y1", "x2", "y2");
    case "freehand":
      return Array.isArray(g.points) && g.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum));
    case "loupe":
      return nums(g, "cx", "cy", "r", "zoom");
    default: {
      if (!nums(g, "x", "y", "w", "h")) return false;
      if (kind === "roundRect") return isNum(g.radius);
      if (kind === "star") return isNum(g.points);
      if (kind === "polygon") return isNum(g.sides);
      if (kind === "text") return isStr(g.text);
      if (kind === "highlight") return g.shape === "rect" || g.shape === "oval";
      if (kind === "signature" || kind === "image") return isStr(g.src);
      if (kind === "bubble") return !!g.tail && nums(g.tail as Record<string, unknown>, "x", "y");
      return true;
    }
  }
}

function validStyle(s: Record<string, unknown>): boolean {
  const ends = ["none", "arrow", "circle"];
  return (
    isStr(s.stroke) &&
    (s.fill === null || isStr(s.fill)) &&
    isNum(s.width) &&
    ["solid", "dashed", "dotted"].includes(s.dash as string) &&
    ends.includes(s.arrowStart as string) &&
    ends.includes(s.arrowEnd as string) &&
    typeof s.shadow === "boolean"
  );
}

/** Lê um `AnnotationDoc`; itens inválidos são descartados e JSON inválido vira documento vazio. */
export function deserialize(json: string): AnnotationDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { items: [] };
  }
  const list = (raw as { items?: unknown })?.items;
  if (!Array.isArray(list)) return { items: [] };
  const items = list.filter((a): a is Annotation => {
    if (!a || typeof a !== "object") return false;
    const o = a as Record<string, unknown>;
    return (
      isStr(o.id) &&
      KINDS.includes(o.kind as Kind) &&
      !!o.geom && typeof o.geom === "object" && validGeom(o.kind as Kind, o.geom as Record<string, unknown>) &&
      !!o.style && typeof o.style === "object" && validStyle(o.style as Record<string, unknown>)
    );
  });
  return { items };
}

// ---- acerto do ponteiro ----

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** A anotação sob (x, y), a de cima primeiro. `tol` em pixels da imagem. */
export function hitTest(items: readonly Annotation[], x: number, y: number, tol: number): Annotation | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const a = items[i];
    const t = tol + a.style.width / 2;
    if (a.kind === "line" || a.kind === "arrow") {
      const g = a.geom;
      if (distToSegment(x, y, g.x1, g.y1, g.x2, g.y2) <= t) return a;
    } else if (a.kind === "freehand") {
      const p = a.geom.points;
      for (let k = 1; k < p.length; k++) if (distToSegment(x, y, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]) <= t) return a;
    } else if (a.kind === "loupe") {
      if (Math.hypot(x - a.geom.cx, y - a.geom.cy) <= a.geom.r + t) return a;
    } else {
      const b = bounds(a);
      if (x >= b.x - t && x <= b.x + b.w + t && y >= b.y - t && y <= b.y + b.h + t) return a;
    }
  }
  return null;
}

// ---- formas derivadas ----

/** Vértices da estrela inscrita na caixa (pontas alternando raio externo e interno). */
export function starVertices(b: Box, points: number, inner = 0.45): Point[] {
  const n = clamp(Math.round(points), COUNT_MIN, COUNT_MAX);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return Array.from({ length: n * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? inner : 1;
    return [cx + (r * b.w * Math.cos(a)) / 2, cy + (r * b.h * Math.sin(a)) / 2] as Point;
  });
}

/** Vértices do polígono regular inscrito na caixa. */
export function polygonVertices(b: Box, sides: number): Point[] {
  const n = clamp(Math.round(sides), COUNT_MIN, COUNT_MAX);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + (b.w * Math.cos(a)) / 2, cy + (b.h * Math.sin(a)) / 2] as Point;
  });
}
