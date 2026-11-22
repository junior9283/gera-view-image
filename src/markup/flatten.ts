// Achatamento das anotações na imagem (`Op::Composite`), chamado ao salvar e exportar (Task 11).
// Imprimir, Exportar como PDF e Duplicar usam só os PNGs (`annotationLayers`) numa cópia, sem tocar
// no original.
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo, Op } from "../ipc/types";
import { useDocs } from "../store/docs";
import { bufferToCanvas } from "../viewer/paint";
import { pushOp } from "./history";
import { bounds, boxOf, type Annotation } from "./model";
import { docOf, hasPages, onPage, shownPage } from "./pages";
import { flattenScale, flattenToPng, renderPng, type Source } from "./render";
import { getItems, useMarkup } from "./store";

/** Pixels do documento para a Lupa, no máximo `max` px no lado maior. */
export async function loadSource(id: DocId, w: number, h: number, max: number, frame = 0): Promise<Source> {
  const k = Math.min(1, max / Math.max(w, h));
  const v = await ipc.renderView(id, frame, Math.round(w * k), Math.round(h * k));
  return { image: bufferToCanvas(v), w: v.width, h: v.height };
}

/** A lupa não precisa de mais resolução que o próprio canvas de achatamento. */
const sourceFor = (doc: DocInfo, items: Annotation[], page: number): Promise<Source> | null =>
  items.some((a) => a.kind === "loupe")
    ? loadSource(doc.id, doc.width, doc.height, Math.max(doc.width, doc.height) * flattenScale(doc.width, doc.height), page)
    : null;

/** PNG só destas anotações da página mostrada (Copiar), com folga para o traço, as pontas e a sombra. */
export async function itemsPng(id: DocId, items: Annotation[]): Promise<Uint8Array> {
  const doc = docOf(id)!;
  const box = boxOf(items.flatMap((a) => {
    const b = bounds(a);
    const pad = Math.max(8, a.style.width * 3.5);
    return [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad]] as [number, number][];
  }));
  return renderPng(items, box, doc.width, doc.height, await sourceFor(doc, items, shownPage(id)));
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
  const png = await flattenToPng(items, doc.width, doc.height, await sourceFor(doc, items, page));
  return { op: { type: "composite", data: hasPages(doc) ? { png, frame: page } : { png } }, items };
}

/** PNG das anotações da página `page`, no tamanho da imagem, ou `null` se não há nenhuma. */
export const annotationsPng = async (id: DocId, page: number) => (await annotationLayer(id, page))?.op.data.png ?? null;

/** Todas as camadas: uma por página com anotações. */
export async function annotationLayers(id: DocId): Promise<Layer[]> {
  const pages = hasPages(docOf(id)) ? [...new Set(getItems(id).map((a) => a.page ?? 0))].sort((a, b) => a - b) : [0];
  const layers: Layer[] = [];
  for (const page of pages) {
    const layer = await annotationLayer(id, page);
    if (layer) layers.push(layer);
  }
  return layers;
}

/**
 * Achata na imagem as anotações da página `page`, a que vai ser gravada; as de outras páginas
 * continuam editáveis. É um passo do desfazer, que volta a imagem e devolve as anotações. Devolve
 * `false` se não havia o que achatar.
 */
export async function flattenAnnotations(id: DocId, page = 0): Promise<boolean> {
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
