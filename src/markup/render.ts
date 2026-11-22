// Desenho das anotações num canvas 2D (camada da tela e achatamento em resolução cheia).
import {
  BUBBLE_RADIUS,
  bounds,
  normBox,
  polygonVertices,
  starVertices,
  textBox,
  textFont,
  type Annotation,
  type Box,
  type FontStyle,
  type Point,
  type Style,
} from "./model";
import { cssFont } from "./fontCss";
import { LINE_HEIGHT, wrapText } from "./textLayout";
import { handlesFor, type HandleColor } from "./tools/handles";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Transformação imagem → tela (px CSS), a mesma do Viewport. */
export interface ViewXf { scale: number; panX: number; panY: number }

/** Pixels da imagem para a Lupa; pode estar em resolução menor (`w`×`h`). */
export interface Source { image: CanvasImageSource; w: number; h: number }

export interface RenderOpts {
  imageW: number;
  imageH: number;
  /** Pixels do dispositivo por px CSS. */
  dpr?: number;
  /** Anotação com o texto em edição: quem o mostra é o `<textarea>` (a forma continua desenhada). */
  skip?: string | null;
}

const TAU = Math.PI * 2;
const HIGHLIGHT_SHADE = "rgba(0,0,0,0.5)";

// ---- imagens (assinaturas) ----

const images = new Map<string, HTMLImageElement>();
const waiting = new Map<string, Set<() => void>>();

/** Imagem decodificada de `src`, ou `null` enquanto carrega (`onLoad` avisa quando chegar). */
export function imageFor(src: string, onLoad?: () => void): HTMLImageElement | null {
  let img = images.get(src);
  if (!img) {
    if (typeof Image === "undefined") return null;
    img = new Image();
    images.set(src, img);
    const done = () => {
      waiting.get(src)?.forEach((f) => f());
      waiting.delete(src);
    };
    img.onload = done;
    img.onerror = done;
    img.src = src;
  }
  if (img.complete && img.naturalWidth > 0) return img;
  if (onLoad) {
    const set = waiting.get(src) ?? new Set();
    set.add(onLoad);
    waiting.set(src, set);
  }
  return null;
}

/** Espera as imagens das anotações (para o achatamento não sair sem a assinatura). */
export async function preloadImages(items: readonly Annotation[]): Promise<void> {
  const srcs = items.flatMap((a) => (a.kind === "signature" || a.kind === "image" ? [a.geom.src] : []));
  await Promise.all(
    srcs.map((src) => (imageFor(src) ? Promise.resolve() : new Promise<void>((res) => imageFor(src, res)))),
  );
}

// ---- estilo ----

function dashFor(s: Style): number[] {
  if (s.dash === "dashed") return [s.width * 3, s.width * 2];
  if (s.dash === "dotted") return [0, s.width * 2];
  return [];
}

function applyStyle(ctx: Ctx, s: Style): void {
  ctx.strokeStyle = s.stroke;
  ctx.fillStyle = s.fill ?? "transparent";
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashFor(s));
  if (s.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = Math.max(2, s.width * 1.5);
    ctx.shadowOffsetX = Math.max(1, s.width * 0.6);
    ctx.shadowOffsetY = Math.max(1, s.width * 0.6);
  }
}

/** Preenche (se houver cor) e contorna o caminho atual. */
function paint(ctx: Ctx, s: Style): void {
  if (s.fill) ctx.fill();
  if (s.width > 0) ctx.stroke();
}

// ---- caminhos ----

function polyPath(ctx: Ctx, pts: readonly Point[], close: boolean): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

function roundRectPath(ctx: Ctx, b: Box, r: number): void {
  const rr = Math.max(0, Math.min(r, b.w / 2, b.h / 2));
  ctx.beginPath();
  ctx.moveTo(b.x + rr, b.y);
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, rr);
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, rr);
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, rr);
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, rr);
  ctx.closePath();
}

const ovalPath = (ctx: Ctx, b: Box) => {
  ctx.beginPath();
  ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, TAU);
};

/**
 * Balão: retângulo arredondado com a cauda saindo do lado voltado para a ponta,
 * num caminho só (o contorno não cruza a base da cauda).
 */
function bubblePath(ctx: Ctx, b: Box, tail: { x: number; y: number }): void {
  const r = Math.min(b.w, b.h) * BUBBLE_RADIUS;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const nx = (tail.x - cx) / (b.w / 2 || 1);
  const ny = (tail.y - cy) / (b.h / 2 || 1);
  const inside = Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
  // Lados no sentido horário: 0 topo, 1 direita, 2 base, 3 esquerda.
  const side = inside ? -1 : Math.abs(ny) >= Math.abs(nx) ? (ny < 0 ? 0 : 2) : nx > 0 ? 1 : 3;
  const corners: Point[] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
  const base = Math.min(b.w, b.h) * 0.3;
  ctx.beginPath();
  ctx.moveTo(b.x + r, b.y);
  for (let i = 0; i < 4; i++) {
    const [a, c] = [corners[(i + 1) % 4], corners[(i + 2) % 4]];
    if (i === side) {
      const p = corners[i];
      const horiz = i % 2 === 0;
      const len = horiz ? b.w : b.h;
      const along = horiz ? tail.x - b.x : tail.y - b.y;
      const dir = i < 2 ? 1 : -1; // topo e direita andam no sentido +; base e esquerda no -
      const from = horiz ? p[0] : p[1];
      const at = Math.min(Math.max(dir > 0 ? along : len - along, r + base / 2), len - r - base / 2);
      const pos = (t: number): Point => (horiz ? [from + dir * t, p[1]] : [p[0], from + dir * t]);
      ctx.lineTo(...pos(at - base / 2));
      ctx.lineTo(tail.x, tail.y);
      ctx.lineTo(...pos(at + base / 2));
    }
    ctx.arcTo(a[0], a[1], c[0], c[1], r);
  }
  ctx.closePath();
}

function arrowHead(ctx: Ctx, tip: Point, from: Point, s: Style, kind: "arrow" | "circle"): void {
  const size = Math.max(8, s.width * 3.5);
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = s.stroke;
  ctx.beginPath();
  if (kind === "circle") {
    ctx.arc(tip[0], tip[1], size / 3, 0, TAU);
  } else {
    const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
    const spread = Math.PI / 7;
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - size * Math.cos(ang - spread), tip[1] - size * Math.sin(ang - spread));
    ctx.lineTo(tip[0] - size * Math.cos(ang + spread), tip[1] - size * Math.sin(ang + spread));
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

function ends(ctx: Ctx, pts: readonly Point[], s: Style): void {
  if (pts.length < 2) return;
  if (s.arrowEnd !== "none") arrowHead(ctx, pts[pts.length - 1], pts[pts.length - 2], s, s.arrowEnd);
  if (s.arrowStart !== "none") arrowHead(ctx, pts[0], pts[1], s, s.arrowStart);
}

/** Linhas dentro de `b` (alinhamento da fonte), a partir do topo `b.y`. */
function drawLines(ctx: Ctx, f: FontStyle, lines: readonly string[], b: Box): void {
  ctx.font = cssFont(f);
  ctx.fillStyle = f.color;
  ctx.textBaseline = "top";
  ctx.textAlign = f.align;
  const x = f.align === "left" ? b.x : f.align === "center" ? b.x + b.w / 2 : b.x + b.w;
  lines.forEach((line, i) => {
    const y = b.y + i * f.size * LINE_HEIGHT;
    ctx.fillText(line, x, y);
    if (f.underline && line) {
      const w = ctx.measureText(line).width;
      const x0 = f.align === "left" ? x : f.align === "center" ? x - w / 2 : x - w;
      ctx.fillRect(x0, y + f.size * 1.05, w, Math.max(1, f.size / 14));
    }
  });
}

/** Texto dentro da forma: quebrado na largura e centralizado na altura. */
function drawShapeText(ctx: Ctx, a: Annotation): void {
  const b = textBox(a);
  if (!b || !a.text) return;
  const f = textFont(a);
  ctx.shadowColor = "transparent"; // a sombra é da forma
  ctx.font = cssFont(f);
  const lines = wrapText(a.text, b.w, (s) => ctx.measureText(s).width);
  drawLines(ctx, f, lines, { ...b, y: b.y + (b.h - lines.length * f.size * LINE_HEIGHT) / 2 });
}

function drawLoupe(ctx: Ctx, a: Extract<Annotation, { kind: "loupe" }>, src: Source | null | undefined, o: RenderOpts): void {
  const { cx, cy, r, zoom } = a.geom;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  if (src) {
    const k = src.w / o.imageW;
    const side = (2 * r) / zoom;
    ctx.imageSmoothingEnabled = zoom < 3;
    ctx.drawImage(src.image, (cx - side / 2) * k, (cy - side / 2) * k, side * k, side * k, cx - r, cy - r, 2 * r, 2 * r);
  } else {
    ctx.fillStyle = "rgba(127,127,127,0.25)";
    ctx.fill();
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = "transparent";
  ctx.stroke();
}

function drawItem(ctx: Ctx, a: Annotation, src: Source | null | undefined, o: RenderOpts, onImage?: () => void): void {
  ctx.save();
  applyStyle(ctx, a.style);
  switch (a.kind) {
    case "line":
    case "arrow": {
      const pts: Point[] = [[a.geom.x1, a.geom.y1], [a.geom.x2, a.geom.y2]];
      polyPath(ctx, pts, false);
      ctx.stroke();
      ends(ctx, pts, a.style);
      break;
    }
    case "freehand":
      polyPath(ctx, a.geom.points, false);
      ctx.stroke();
      ends(ctx, a.geom.points, a.style);
      break;
    case "rect": {
      const b = normBox(a.geom);
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      paint(ctx, a.style);
      break;
    }
    case "roundRect":
      roundRectPath(ctx, normBox(a.geom), a.geom.radius);
      paint(ctx, a.style);
      break;
    case "oval":
      ovalPath(ctx, normBox(a.geom));
      paint(ctx, a.style);
      break;
    case "bubble":
      bubblePath(ctx, normBox(a.geom), a.geom.tail);
      paint(ctx, a.style);
      break;
    case "star":
      polyPath(ctx, starVertices(normBox(a.geom), a.geom.points), true);
      paint(ctx, a.style);
      break;
    case "polygon":
      polyPath(ctx, polygonVertices(normBox(a.geom), a.geom.sides), true);
      paint(ctx, a.style);
      break;
    case "text":
      if (a.id !== o.skip) drawLines(ctx, textFont(a), a.geom.text.split("\n"), normBox(a.geom));
      break;
    case "loupe":
      drawLoupe(ctx, a, src, o);
      break;
    case "signature":
    case "image": {
      const img = imageFor(a.geom.src, onImage);
      const b = normBox(a.geom);
      if (img) ctx.drawImage(img, b.x, b.y, b.w, b.h);
      break;
    }
    case "highlight":
      break; // desenhado à parte (máscara única)
  }
  if (a.id !== o.skip) drawShapeText(ctx, a);
  ctx.restore();
}

/** Escurece tudo fora dos realces numa camada só: vários realces se somam. */
function drawHighlights(ctx: Ctx, hl: Extract<Annotation, { kind: "highlight" }>[], o: RenderOpts): void {
  ctx.save();
  ctx.fillStyle = HIGHLIGHT_SHADE;
  ctx.fillRect(0, 0, o.imageW, o.imageH);
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  for (const h of hl) {
    const b = normBox(h.geom);
    if (h.geom.shape === "oval") ovalPath(ctx, b);
    else {
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
    }
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Desenha as anotações em `ctx` (que deve estar limpo: os realces recortam a própria
 * camada). `view` leva da imagem para a tela; `source` alimenta a Lupa.
 */
export function render(
  ctx: Ctx,
  items: readonly Annotation[],
  view: ViewXf,
  source: Source | null | undefined,
  opts: RenderOpts,
  onImage?: () => void,
): void {
  const k = opts.dpr ?? 1;
  ctx.save();
  ctx.setTransform(k * view.scale, 0, 0, k * view.scale, k * view.panX, k * view.panY);
  const hl = items.filter((a): a is Extract<Annotation, { kind: "highlight" }> => a.kind === "highlight");
  if (hl.length) drawHighlights(ctx, hl, opts);
  for (const a of items) if (a.kind !== "highlight") drawItem(ctx, a, source, opts, onImage);
  ctx.restore();
}

const HANDLE_FILL: Record<HandleColor, string> = { white: "#ffffff", green: "#34c759", blue: "#0a84ff", yellow: "#ffcc00" };

/** Contorno tracejado e alças das selecionadas, em px de tela (tamanho fixo em qualquer zoom). */
export function renderSelection(ctx: Ctx, items: readonly Annotation[], selected: readonly string[], view: ViewXf, dpr = 1): void {
  if (!selected.length) return;
  const set = new Set(selected);
  const sx = (x: number) => view.panX + x * view.scale;
  const sy = (y: number) => view.panY + y * view.scale;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const a of items) {
    if (!set.has(a.id)) continue;
    if (a.kind !== "line" && a.kind !== "arrow") {
      const r = a.kind === "bubble" ? normBox(a.geom) : bounds(a);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#0a84ff";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx(r.x) - 0.5, sy(r.y) - 0.5, r.w * view.scale + 1, r.h * view.scale + 1);
    }
    ctx.setLineDash([]);
    for (const h of handlesFor(a, view.scale)) {
      ctx.beginPath();
      ctx.arc(sx(h.x), sy(h.y), 4.5, 0, TAU);
      ctx.fillStyle = HANDLE_FILL[h.color];
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Acima disto (pixels) o achatamento sai em resolução menor e o Rust amplia ao compor. */
const MAX_FLAT_PIXELS = 64e6;

/** Escala do canvas de achatamento (1 até 64 MP). */
export const flattenScale = (w: number, h: number) => Math.min(1, Math.sqrt(MAX_FLAT_PIXELS / (w * h)));

/**
 * Achata as anotações num PNG transparente do tamanho da imagem (canvas offscreen),
 * pronto para `Op::Composite`.
 */
export const flattenToPng = (items: readonly Annotation[], w: number, h: number, source: Source | null): Promise<Uint8Array> =>
  renderPng(items, { x: 0, y: 0, w, h }, w, h, source);

/** PNG transparente da região `area` (px da imagem `imageW`×`imageH`) com as anotações. */
export async function renderPng(
  items: readonly Annotation[], area: Box, imageW: number, imageH: number, source: Source | null,
): Promise<Uint8Array> {
  const k = flattenScale(area.w, area.h);
  const [cw, ch] = [Math.max(1, Math.round(area.w * k)), Math.max(1, Math.round(area.h * k))];
  await preloadImages(items);
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(cw, ch)
      : Object.assign(document.createElement("canvas"), { width: cw, height: ch });
  const ctx = canvas.getContext("2d") as Ctx | null;
  if (!ctx) throw new Error("canvas 2D indisponível para achatar as anotações");
  render(ctx, items, { scale: k, panX: -area.x * k || 0, panY: -area.y * k || 0 }, source, { imageW, imageH, dpr: 1 });
  const blob =
    "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob falhou"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
