// Seleções compostas: somar, subtrair, mover e testar um ponto, em px da imagem.
import type { Mask, Rect } from "../ipc/types";
import { boxOf } from "../markup/model";
import { coverageToRle, maskBounds, rasterize } from "./lasso";

export type SelectMode = "replace" | "add" | "subtract";

/**
 * Regra das teclas ao começar a arrastar: com uma seleção, Shift soma e Alt subtrai. Sem seleção
 * prévia não há o que compor, e o Shift mantém o sentido de forçar quadrado/círculo.
 */
export const modeFor = (selection: Mask | null, e: { shiftKey: boolean; altKey: boolean }): SelectMode =>
  !selection ? "replace" : e.altKey ? "subtract" : e.shiftKey ? "add" : "replace";

/** União (`add`) ou diferença (`subtract`) de `a` com `b`; `null` se não sobrar nada. */
export function combineMasks(a: Mask, b: Mask, mode: "add" | "subtract", w: number, h: number): Mask | null {
  // Uma cobertura da imagem inteira só (100 MP = 100 MB): `b` entra pela região que ocupa.
  const cov = rasterize(a, w, h);
  paintInto(cov, b, w, h, mode === "add" ? 1 : 0);
  return cov.includes(1) ? { type: "bitmap", data: { w, h, rle: coverageToRle(cov) } } : null;
}

/** Escreve `value` em `cov` (w×h) nos pixels de `m`, sem alocar outra cobertura da imagem inteira. */
function paintInto(cov: Uint8Array, m: Mask, w: number, h: number, value: 0 | 1): void {
  if (m.type === "bitmap") {
    const { w: mw, h: mh, rle } = m.data;
    let pos = 0;
    rle.forEach((run, i) => {
      const end = Math.min(pos + run, mw * mh);
      for (let at = pos; i % 2 && at < end; ) {
        const [x, y] = [at % mw, Math.floor(at / mw)];
        const stop = Math.min(end - at, mw - x); // até o fim da corrida ou da linha
        if (y < h && x < w) cov.fill(value, y * w + x, y * w + Math.min(w, x + stop));
        at += stop;
      }
      pos = end;
    });
    return;
  }
  const box = boundsOf(m, w, h);
  if (!box) return;
  const [x0, y0] = [Math.max(0, Math.floor(box.x)), Math.max(0, Math.floor(box.y))];
  const [x1, y1] = [Math.min(w, Math.ceil(box.x + box.w)), Math.min(h, Math.ceil(box.y + box.h))];
  if (x1 <= x0 || y1 <= y0) return;
  // O centro de cada pixel decide: deslocar por inteiros não muda quais ficam dentro.
  const local: Mask =
    m.type === "polygon"
      ? { type: "polygon", data: m.data.map(([px, py]) => [px - x0, py - y0]) }
      : { type: m.type, data: { ...m.data, x: m.data.x - x0, y: m.data.y - y0 } };
  const rw = x1 - x0;
  const part = rasterize(local, rw, y1 - y0);
  for (let i = 0; i < part.length; i++) if (part[i]) cov[(y0 + Math.floor(i / rw)) * w + x0 + (i % rw)] = value;
}

type Bitmap = Extract<Mask, { type: "bitmap" }>;

/** Desloca as corridas. Quem chama garante que nada sai da imagem: basta andar `by` na ordem de linha. */
function shiftBitmap(m: Bitmap, by: number): Bitmap {
  const { w, h, rle } = m.data;
  const out = rle.slice();
  out[0] = (out[0] ?? 0) + by;
  // A última corrida de "fora" cede (ou ganha) o que a primeira ganhou (ou cedeu).
  if (out.length % 2) out[out.length - 1] = Math.max(0, out[out.length - 1] - by);
  else if (by < 0) out.push(-by);
  return { type: "bitmap", data: { w, h, rle: out } };
}

export function boundsOf(m: Mask, w: number, h: number): Rect | null {
  if (m.type === "polygon") return boxOf(m.data);
  return m.type === "bitmap" ? maskBounds(m, w, h) : m.data;
}

const limit = (d: number, at: number, size: number, max: number) =>
  // `|| 0`: sem -0, que apareceria nas coordenadas.
  Math.min(Math.max(0, max - size - at), Math.max(Math.min(0, -at), Math.round(d))) || 0;

/** Move a seleção, parando na borda da imagem; sem poder andar, devolve a mesma máscara. */
export function moveMask(m: Mask, dx: number, dy: number, w: number, h: number, bounds = boundsOf(m, w, h)): Mask {
  if (!bounds) return m;
  const x = limit(dx, bounds.x, bounds.w, w);
  const y = limit(dy, bounds.y, bounds.h, h);
  if (!x && !y) return m;
  switch (m.type) {
    case "polygon":
      return { type: "polygon", data: m.data.map(([px, py]) => [px + x, py + y]) };
    case "bitmap":
      return shiftBitmap(m, y * m.data.w + x);
    default:
      return { type: m.type, data: { ...m.data, x: m.data.x + x, y: m.data.y + y } };
  }
}

/** Se o ponto (px da imagem) está dentro da seleção. */
export function maskContains(m: Mask, x: number, y: number): boolean {
  switch (m.type) {
    case "rect":
      return x >= m.data.x && y >= m.data.y && x < m.data.x + m.data.w && y < m.data.y + m.data.h;
    case "ellipse": {
      const [rx, ry] = [m.data.w / 2, m.data.h / 2];
      return rx > 0 && ry > 0 && ((x - m.data.x - rx) / rx) ** 2 + ((y - m.data.y - ry) / ry) ** 2 <= 1;
    }
    case "polygon": {
      let in_ = false;
      m.data.forEach((a, i) => {
        const b = m.data[(i + 1) % m.data.length];
        if (a[1] <= y !== b[1] <= y && x >= a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) in_ = !in_;
      });
      return in_;
    }
    case "bitmap": {
      const { w, h, rle } = m.data;
      const [px, py] = [Math.floor(x), Math.floor(y)];
      if (px < 0 || py < 0 || px >= w || py >= h) return false;
      let left = py * w + px;
      for (let i = 0; i < rle.length; i++) {
        if (left < rle[i]) return i % 2 === 1;
        left -= rle[i];
      }
      return false;
    }
  }
}
