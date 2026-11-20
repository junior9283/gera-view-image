// Achatamento das anotações na imagem (`Op::Composite`), chamado ao salvar e exportar (Task 11).
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { bufferToCanvas } from "../viewer/paint";
import { pushFlatten } from "./history";
import { flattenToPng, type Source } from "./render";
import { getItems, useMarkup } from "./store";

/** Pixels do documento para a Lupa, no máximo `max` px no lado maior. */
export async function loadSource(id: DocId, w: number, h: number, max = Infinity): Promise<Source> {
  const k = Math.min(1, max / Math.max(w, h));
  const v = await ipc.renderView(id, 0, Math.round(w * k), Math.round(h * k));
  return { image: bufferToCanvas(v), w: v.width, h: v.height };
}

/**
 * Achata as anotações de `id` na imagem como um passo do desfazer (desfazer volta a
 * imagem e devolve as anotações editáveis). Devolve `false` se não havia o que achatar.
 */
export async function flattenAnnotations(id: DocId): Promise<boolean> {
  const items = getItems(id);
  const doc = useDocs.getState().docs.find((d) => d.id === id);
  if (!items.length || !doc) return false;
  const source = items.some((a) => a.kind === "loupe") ? await loadSource(id, doc.width, doc.height) : null;
  const png = await flattenToPng(items, doc.width, doc.height, source);
  // Direto pelo IPC: o passo entra como "achatar", não como uma Op comum.
  const info = await ipc.applyOp(id, { type: "composite", data: { png } });
  useDocs.getState().update(info);
  pushFlatten(id, items);
  useMarkup.getState().setItems(id, []);
  return true;
}
