import type { Mask, Rect } from "../ipc/types";

/** Unidades da aba Recorte (as do painel de informações do Pré-Visualização). */
export type CropUnit = "px" | "pt" | "mm" | "cm" | "in";
export const CROP_UNITS: readonly CropUnit[] = ["px", "pt", "mm", "cm", "in"];

/** Pixels por unidade, dada a resolução em ppp (72 quando o arquivo não informa). */
const PX_PER_UNIT: Record<CropUnit, (dpi: number) => number> = {
  px: () => 1,
  pt: (dpi) => dpi / 72,
  mm: (dpi) => dpi / 25.4,
  cm: (dpi) => dpi / 2.54,
  in: (dpi) => dpi,
};

const safeDpi = (dpi: number | null | undefined) => (dpi && Number.isFinite(dpi) && dpi > 0 ? dpi : 72);

export const toPx = (value: number, unit: CropUnit, dpi: number | null | undefined) =>
  value * PX_PER_UNIT[unit](safeDpi(dpi));

export const fromPx = (px: number, unit: CropUnit, dpi: number | null | undefined) =>
  px / PX_PER_UNIT[unit](safeDpi(dpi));

/** Texto de um valor na unidade: inteiro em px, duas casas nas demais. */
export function formatUnit(px: number, unit: CropUnit, dpi: number | null | undefined): string {
  const v = fromPx(px, unit, dpi);
  return unit === "px" ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
}

/** Seleções que o painel edita (retângulo e elipse); as outras só mostram a caixa. */
export const isEditable = (m: Mask): m is Extract<Mask, { type: "rect" | "ellipse" }> =>
  m.type === "rect" || m.type === "ellipse";

/** Caixa que envolve a seleção, em pixels da imagem; `null` se estiver vazia. */
export function maskBounds(m: Mask): Rect | null {
  switch (m.type) {
    case "rect":
    case "ellipse":
      return m.data;
    case "polygon": {
      const pts = m.data.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      if (pts.length === 0) return null;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
      return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
    }
    case "bitmap":
      return bitmapBounds(m.data.w, m.data.h, m.data.rle);
  }
}

/** `rle`: corridas alternadas sobre w*h (linha a linha), começando por "fora". */
function bitmapBounds(w: number, h: number, rle: number[]): Rect | null {
  if (!(w > 0) || !(h > 0)) return null;
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  let pos = 0;
  rle.forEach((n, i) => {
    if (!(n > 0)) return;
    if (i % 2 === 1) {
      const [s, e] = [pos, Math.min(pos + n, w * h) - 1];
      if (s <= e) {
        const [ys, ye] = [Math.floor(s / w), Math.floor(e / w)];
        y0 = Math.min(y0, ys);
        y1 = Math.max(y1, ye);
        x0 = Math.min(x0, ys === ye ? s % w : 0);
        x1 = Math.max(x1, ys === ye ? e % w : w - 1);
      }
    }
    pos += n;
  });
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Troca um campo (em pixels) e mantém o retângulo inteiro, com pelo menos 1 px e dentro da imagem. */
export function withField(r: Rect, field: keyof Rect, px: number, imgW: number, imgH: number): Rect {
  if (!Number.isFinite(px)) return r;
  const v = Math.round(px);
  const next = { ...r };
  if (field === "x") next.x = Math.min(Math.max(0, v), Math.max(0, imgW - 1));
  else if (field === "y") next.y = Math.min(Math.max(0, v), Math.max(0, imgH - 1));
  else if (field === "w") next.w = Math.max(1, v);
  else next.h = Math.max(1, v);
  next.w = Math.min(next.w, Math.max(1, imgW - next.x));
  next.h = Math.min(next.h, Math.max(1, imgH - next.y));
  return next;
}
