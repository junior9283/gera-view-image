import type { Mask, Rect } from "../ipc/types";

export type Point = [number, number];

function distToSegment(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker (iterativo, sem estourar a pilha em traços longos). */
export function simplifyPath(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(points[i], points[lo], points[hi]);
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > epsilon) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Cobertura por pixel (1 = dentro; o centro do pixel decide), em ordem de linha. */
export function rasterize(mask: Mask, w: number, h: number): Uint8Array {
  const cov = new Uint8Array(w * h);
  switch (mask.type) {
    case "rect": {
      const r = mask.data;
      for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++)
        cov.fill(1, y * w + Math.max(0, r.x), y * w + Math.min(w, r.x + r.w));
      break;
    }
    case "ellipse": {
      const r = mask.data;
      const [rx, ry] = [r.w / 2, r.h / 2];
      const [cx, cy] = [r.x + rx, r.y + ry];
      for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
        const dy = (y + 0.5 - cy) / ry;
        if (Math.abs(dy) > 1) continue;
        const half = rx * Math.sqrt(1 - dy * dy);
        for (let x = Math.max(0, Math.floor(cx - half)); x < Math.min(w, Math.ceil(cx + half) + 1); x++)
          if (Math.abs(x + 0.5 - cx) <= half) cov[y * w + x] = 1;
      }
      break;
    }
    case "polygon": {
      const pts = mask.data;
      for (let y = 0; y < h; y++) {
        const yc = y + 0.5;
        const xs: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
          if (a[1] <= yc !== b[1] <= yc) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const x0 = Math.max(0, Math.ceil(xs[i] - 0.5));
          const x1 = Math.min(w, Math.ceil(xs[i + 1] - 0.5));
          if (x0 < x1) cov.fill(1, y * w + x0, y * w + x1);
        }
      }
      break;
    }
    case "bitmap": {
      const { w: mw, h: mh, rle } = mask.data;
      let pos = 0;
      let inside = false;
      for (const run of rle) {
        const end = Math.min(pos + run, mw * mh);
        if (inside)
          for (let i = pos; i < end; i++) {
            const [x, y] = [i % mw, Math.floor(i / mw)];
            if (x < w && y < h) cov[y * w + x] = 1;
          }
        pos = end;
        inside = !inside;
      }
      break;
    }
  }
  return cov;
}

/** Corridas alternadas começando por "fora" (mesmo formato do Rust). */
export function coverageToRle(cov: Uint8Array): number[] {
  const rle: number[] = [];
  let inside = 0;
  let run = 0;
  for (const c of cov) {
    if (c === inside) run++;
    else {
      rle.push(run);
      inside = c;
      run = 1;
    }
  }
  rle.push(run);
  return rle;
}

export function maskArea(mask: Mask, w: number, h: number): number {
  let n = 0;
  for (const c of rasterize(mask, w, h)) n += c;
  return n;
}

/** Retângulo que contém a máscara, ou `null` se estiver vazia. */
export function maskBounds(mask: Mask, w: number, h: number): Rect | null {
  if (mask.type === "rect") {
    // Atalho sem rasterizar: interseção com a imagem.
    const { x, y, w: rw, h: rh } = mask.data;
    const [x0, y0, x1, y1] = [Math.max(0, x), Math.max(0, y), Math.min(w, x + rw), Math.min(h, y + rh)];
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  const cov = rasterize(mask, w, h);
  let [x0, y0, x1, y1] = [w, h, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (cov[y * w + x]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Amostra um Bitmap numa grade grosseira (1 célula a cada `step` px) sem expandir `w*h`. */
export function sampleBitmap(
  mask: Extract<Mask, { type: "bitmap" }>,
  maxDim = 1024,
): { cells: Uint8Array; tw: number; th: number; step: number } {
  const { w, h, rle } = mask.data;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  const [tw, th] = [Math.ceil(w / step), Math.ceil(h / step)];
  const cells = new Uint8Array(tw * th);
  let pos = 0;
  let inside = false;
  for (const run of rle) {
    const end = Math.min(pos + run, w * h);
    if (inside && end > pos) {
      const [firstRow, lastRow] = [Math.floor(pos / w), Math.floor((end - 1) / w)];
      for (let y = firstRow; y <= lastRow; y++) {
        if (y % step) continue;
        const x0 = y === firstRow ? pos % w : 0;
        const x1 = y === lastRow ? ((end - 1) % w) + 1 : w;
        for (let tx = Math.ceil(x0 / step); tx * step < x1; tx++) cells[(y / step) * tw + tx] = 1;
      }
    }
    pos = end;
    inside = !inside;
  }
  return { cells, tw, th, step };
}

/** Complemento da máscara, como Bitmap do tamanho da imagem. */
export function invertMask(mask: Mask, w: number, h: number): Mask {
  const cov = rasterize(mask, w, h);
  for (let i = 0; i < cov.length; i++) cov[i] ^= 1;
  return { type: "bitmap", data: { w, h, rle: coverageToRle(cov) } };
}
