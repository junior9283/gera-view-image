// Achatamento das anotações na imagem (`Op::Composite`), chamado ao salvar e exportar (Task 11).
// Imprimir e Duplicar usam só o PNG (`annotationsPng`) numa cópia, sem tocar no original.
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { bufferToCanvas } from "../viewer/paint";
import { pushOp } from "./history";
import { flattenScale, flattenToPng, type Source } from "./render";
import { getItems, useMarkup } from "./store";

/** Pixels do documento para a Lupa, no máximo `max` px no lado maior. */
export async function loadSource(id: DocId, w: number, h: number, max: number): Promise<Source> {
  const k = Math.min(1, max / Math.max(w, h));
  const v = await ipc.renderView(id, 0, Math.round(w * k), Math.round(h * k));
  return { image: bufferToCanvas(v), w: v.width, h: v.height };
}

/** PNG das anotações de `id` no tamanho da imagem (para `Op::Composite`), ou `null` se não há nenhuma. */
export async function annotationsPng(id: DocId): Promise<Uint8Array | null> {
  const items = getItems(id);
  const doc = useDocs.getState().docs.find((d) => d.id === id);
  if (!items.length || !doc) return null;
  // A lupa não precisa de mais resolução que o próprio canvas de achatamento.
  const max = Math.max(doc.width, doc.height) * flattenScale(doc.width, doc.height);
  const source = items.some((a) => a.kind === "loupe") ? await loadSource(id, doc.width, doc.height, max) : null;
  return flattenToPng(items, doc.width, doc.height, source);
}

/**
 * Achata as anotações de `id` na imagem como um passo do desfazer (desfazer volta a
 * imagem e devolve as anotações editáveis). Devolve `false` se não havia o que achatar.
 */
export async function flattenAnnotations(id: DocId): Promise<boolean> {
  const items = getItems(id);
  const png = await annotationsPng(id);
  if (!png) return false;
  // Direto pelo IPC: o passo leva as anotações (desfazer as devolve), não é uma Op comum.
  const info = await ipc.applyOp(id, { type: "composite", data: { png } });
  useDocs.getState().update(info);
  pushOp(id, { before: items, after: [] });
  useMarkup.getState().setItems(id, []);
  return true;
}
