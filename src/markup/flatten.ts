// Achatamento das anotações na imagem (`Op::Composite`), chamado ao salvar e exportar (Task 11).
// Imprimir, Exportar como PDF e Duplicar usam só os PNGs (`annotationLayers`) numa cópia, sem tocar
// no original.
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo, Op } from "../ipc/types";
import { useDocs } from "../store/docs";
import { bufferToCanvas } from "../viewer/paint";
import { pushOp } from "./history";
import type { Annotation } from "./model";
import { docOf, hasPages, onPage } from "./pages";
import { flattenScale, flattenToPng, type Source } from "./render";
import { getItems, useMarkup } from "./store";

/** Pixels do documento para a Lupa, no máximo `max` px no lado maior. */
export async function loadSource(id: DocId, w: number, h: number, max: number, frame = 0): Promise<Source> {
  const k = Math.min(1, max / Math.max(w, h));
  const v = await ipc.renderView(id, frame, Math.round(w * k), Math.round(h * k));
  return { image: bufferToCanvas(v), w: v.width, h: v.height };
}

async function pngOf(doc: DocInfo, items: Annotation[], frame: number): Promise<Uint8Array> {
  // A lupa não precisa de mais resolução que o próprio canvas de achatamento.
  const max = Math.max(doc.width, doc.height) * flattenScale(doc.width, doc.height);
  const source = items.some((a) => a.kind === "loupe") ? await loadSource(doc.id, doc.width, doc.height, max, frame) : null;
  return flattenToPng(items, doc.width, doc.height, source);
}

/** PNG das anotações da primeira página de `id`, no tamanho da imagem, ou `null` se não há nenhuma. */
export async function annotationsPng(id: DocId): Promise<Uint8Array | null> {
  const doc = docOf(id);
  const items = onPage(getItems(id), doc, 0);
  return items.length && doc ? pngOf(doc, items, 0) : null;
}

/** Anotações achatadas em PNG: a operação e as anotações que ela consome. */
export interface Layer {
  op: Extract<Op, { type: "composite" }>;
  items: Annotation[];
}

/** Uma camada por página com anotações; fora de um documento de várias páginas, uma só. */
export async function annotationLayers(id: DocId): Promise<Layer[]> {
  const doc = docOf(id);
  const all = getItems(id);
  if (!doc || !all.length) return [];
  if (!hasPages(doc)) return [{ op: { type: "composite", data: { png: await pngOf(doc, all, 0) } }, items: all }];
  const pages = [...new Set(all.map((a) => a.page ?? 0))].sort((a, b) => a - b);
  const layers: Layer[] = [];
  for (const frame of pages) {
    const items = onPage(all, doc, frame);
    layers.push({ op: { type: "composite", data: { png: await pngOf(doc, items, frame), frame } }, items });
  }
  return layers;
}

/**
 * Achata as anotações de `id` na imagem, um passo do desfazer por página anotada (desfazer volta
 * a imagem e devolve as anotações editáveis). Devolve `false` se não havia o que achatar.
 */
export async function flattenAnnotations(id: DocId): Promise<boolean> {
  const layers = await annotationLayers(id);
  let before = getItems(id);
  for (const { op, items } of layers) {
    // Direto pelo IPC: o passo leva as anotações (desfazer as devolve), não é uma Op comum.
    const info = await ipc.applyOp(id, op);
    useDocs.getState().update(info);
    const after = before.filter((a) => !items.includes(a));
    pushOp(id, { before, after });
    useMarkup.getState().setItems(id, after);
    before = after;
  }
  return layers.length > 0;
}
