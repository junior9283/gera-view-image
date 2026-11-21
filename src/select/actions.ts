// Ações de seleção para os menus/atalhos (Task 6). Atuam no documento ativo.
import * as ipc from "../ipc/commands";
import { annotationsPng } from "../markup/flatten";
import type { DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { invertMask, maskBounds } from "./lasso";

const activeDoc = (): DocInfo | undefined => {
  const { docs, activeId } = useDocs.getState();
  return docs.find((d) => d.id === activeId);
};
const { getState: sel } = useSelection;

export const deselect = () => sel().setSelection(null);

export function selectAll() {
  const doc = activeDoc();
  if (doc) sel().setSelection({ type: "rect", data: { x: 0, y: 0, w: doc.width, h: doc.height } });
}

export function invertSelection() {
  const doc = activeDoc();
  const { selection, setSelection } = sel();
  if (doc && selection) setSelection(invertMask(selection, doc.width, doc.height));
}

/** Ativa o Alfa Instantâneo (clicar e arrastar na imagem). */
export const startInstantAlpha = () => sel().setSelectionTool("instantAlpha");

/** Recortar (Ctrl+K): corta no retângulo da seleção; numa seleção não retangular, antes torna
 *  transparente o que está fora da máscara. */
export async function cropToSelection() {
  const doc = activeDoc();
  const { selection } = sel();
  if (!doc || !selection) return;
  const bounds = maskBounds(selection, doc.width, doc.height);
  if (!bounds) return;
  // Uma op só (um desfazer, sem estado parcial): fora da máscara vira transparente e depois corta.
  const data = selection.type === "rect" ? bounds : { ...bounds, mask: selection };
  await useDocs.getState().applyOp(doc.id, { type: "crop", data });
  deselect();
}

/** Copiar: a seleção ou, sem seleção, a imagem inteira, sempre como aparece (com as anotações). */
export async function copySelection() {
  const doc = activeDoc();
  if (!doc) return;
  const { selection } = sel();
  const png = await annotationsPng(doc.id);
  await (png ? ipc.copyImage(doc.id, selection, png) : ipc.copyRegion(doc.id, selection));
}

export async function deleteSelection() {
  const doc = activeDoc();
  const { selection } = sel();
  if (doc && selection) await useDocs.getState().applyOp(doc.id, { type: "erase", data: selection });
}

export async function cutSelection() {
  if (!sel().selection) return;
  await copySelection();
  await deleteSelection();
}
