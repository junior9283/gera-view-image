// Achatamento das anotações na imagem (`Op::Composite`), chamado ao salvar e exportar (Task 11).
// Imprimir, Exportar como PDF e Duplicar usam só os PNGs (`annotationLayers`) numa cópia, sem tocar
// no original.
import * as ipc from "../ipc/commands";
import type { DocId, Op } from "../ipc/types";
import { useDocs } from "../store/docs";
import { bufferToCanvas } from "../viewer/paint";
import { pushOp } from "./history";
import type { Annotation } from "./model";
import { docOf, hasPages, onPage, pageSize } from "./pages";
import { flattenScale, flattenToPng, type Source } from "./render";
import { getItems, useMarkup } from "./store";

/** Pixels do documento para a Lupa, no máximo `max` px no lado maior. */
export async function loadSource(id: DocId, w: number, h: number, max: number, frame = 0): Promise<Source> {
  const k = Math.min(1, max / Math.max(w, h));
  const v = await ipc.renderView(id, frame, Math.round(w * k), Math.round(h * k));
  return { image: bufferToCanvas(v), w: v.width, h: v.height };
}

/** Anotações achatadas em PNG: a operação e as anotações que ela consome. */
export interface Layer {
  op: Extract<Op, { type: "composite" }>;
  items: Annotation[];
}

/** Camada das anotações da página `page` (de todas, fora de um documento de várias páginas). */
export async function annotationLayer(id: DocId, page: number): Promise<Layer | null> {
  const doc = docOf(id);
  const items = onPage(getItems(id), doc, page);
  if (!doc || !items.length) return null;
  // A lupa não precisa de mais resolução que o próprio canvas de achatamento.
  const { w, h } = pageSize(doc, page);
  const max = Math.max(w, h) * flattenScale(w, h);
  const source = items.some((a) => a.kind === "loupe") ? await loadSource(id, w, h, max, page) : null;
  const png = await flattenToPng(items, w, h, source);
  return { op: { type: "composite", data: hasPages(doc) ? { png, frame: page } : { png } }, items };
}

/** PNG das anotações da página `page`, no tamanho da imagem, ou `null` se não há nenhuma. */
export const annotationsPng = async (id: DocId, page: number) => (await annotationLayer(id, page))?.op.data.png ?? null;

/** Páginas de `id` com anotações (fora de um documento de várias páginas, a única). */
const annotatedPages = (id: DocId): number[] =>
  hasPages(docOf(id)) ? [...new Set(getItems(id).map((a) => a.page ?? 0))].sort((a, b) => a - b) : [0];

/** Todas as camadas: uma por página com anotações. */
export async function annotationLayers(id: DocId): Promise<Layer[]> {
  const layers: Layer[] = [];
  for (const page of annotatedPages(id)) {
    const layer = await annotationLayer(id, page);
    if (layer) layers.push(layer);
  }
  return layers;
}

/**
 * Achata na imagem as anotações da página `page`, a que vai ser gravada; as de outras páginas
 * continuam editáveis. `null`: as de todas (Salvar um TIFF de várias páginas). Cada página é um passo
 * do desfazer, que volta a imagem e devolve as anotações. Devolve `false` se não havia o que achatar.
 */
export async function flattenAnnotations(id: DocId, page: number | null = 0): Promise<boolean> {
  if (page === null) {
    let any = false;
    for (const p of annotatedPages(id)) any = (await flattenAnnotations(id, p)) || any;
    return any;
  }
  const layer = await annotationLayer(id, page);
  if (!layer) return false;
  // Direto pelo IPC: o passo leva as anotações (desfazer as devolve), não é uma Op comum.
  const info = await ipc.applyOp(id, layer.op);
  useDocs.getState().update(info);
  // Relidas: outra anotação pode ter nascido durante o IPC.
  const done = new Set(layer.items.map((a) => a.id));
  const before = getItems(id);
  const after = before.filter((a) => !done.has(a.id));
  pushOp(id, { before, after });
  useMarkup.getState().setItems(id, after);
  return true;
}
