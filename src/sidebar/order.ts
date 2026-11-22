// Geometria e ordem das miniaturas (barra lateral e folha de contatos): contas puras.
import type { DocId } from "../ipc/types";

export interface Point {
  x: number;
  y: number;
}
export type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom">;
export type Layout = "list" | "grid";

/** Índice para onde a tecla leva numa grade de `cols` colunas; `rows` = linhas por página. `null` = não é de navegação. */
export function gridIndex(key: string, at: number, count: number, cols: number, rows: number): number | null {
  if (!count) return null;
  const last = count - 1;
  const row = (i: number) => Math.floor(i / cols);
  const down = (n: number) => {
    if (at + n * cols <= last) return at + n * cols;
    return row(at) < row(last) ? last : at;
  };
  const up = (n: number) => at - Math.min(n, row(at)) * cols;
  switch (key) {
    case "ArrowRight": return Math.min(last, at + 1);
    case "ArrowLeft": return Math.max(0, at - 1);
    case "ArrowDown": return down(1);
    case "ArrowUp": return up(1);
    case "PageDown": return down(Math.max(1, rows));
    case "PageUp": return up(Math.max(1, rows));
    case "Home": return 0;
    case "End": return last;
    default: return null;
  }
}

/** Posição de inserção (antes do item do índice; `items.length` = fim) do ponto `p`. */
export function dropIndex(items: Box[], p: Point, layout: Layout): number {
  const i = items.findIndex((r) => {
    if (p.y < r.top) return true;
    if (p.y > r.bottom) return false;
    return layout === "list" ? p.y < (r.top + r.bottom) / 2 : p.x < (r.left + r.right) / 2;
  });
  return i < 0 ? items.length : i;
}

/** `order` com `moving` (nessa ordem) levados para antes do item que está em `to`. */
export function moveIds(order: DocId[], moving: DocId[], to: number): DocId[] {
  const known = new Set(order);
  const block = moving.filter((id) => known.has(id));
  const out = new Set(block);
  const before = order.slice(0, to).filter((id) => !out.has(id));
  const after = order.slice(to).filter((id) => !out.has(id));
  return [...before, ...block, ...after];
}

/** Índices dos itens tocados pelo retângulo de seleção entre `a` e `b`. */
export function marqueeHits(items: Box[], a: Point, b: Point): number[] {
  const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
  const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
  return items.flatMap((r, i) => (r.left <= x1 && r.right >= x0 && r.top <= y1 && r.bottom >= y0 ? [i] : []));
}
