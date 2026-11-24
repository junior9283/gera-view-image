// Lote 4: Remover Fundo e Copiar Objeto. A máscara do sujeito vem do backend (`segment_subject`,
// U²-Netp em Rust); o modelo é baixado uma vez, depois de o usuário aceitar.
import { create } from "zustand";
import { codeOf, notify, notifyError } from "../chrome/notify";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { DocInfo, Mask } from "../ipc/types";
import { hasPages, shownPage } from "../markup/pages";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";

export type SubjectPhase =
  | { kind: "idle" }
  /** Pedindo permissão para baixar o modelo. */
  | { kind: "ask" }
  | { kind: "busy"; downloading: boolean };

export const useSubject = create<{ phase: SubjectPhase }>(() => ({ phase: { kind: "idle" } }));
const setPhase = (phase: SubjectPhase) => useSubject.setState({ phase });

const activeDoc = (): DocInfo | undefined => {
  const { docs, activeId } = useDocs.getState();
  return docs.find((d) => d.id === activeId);
};

/** Página mostrada, num documento de várias páginas (numa animação, o primeiro quadro). */
const pageOf = (doc: DocInfo | undefined): number => (doc && hasPages(doc) ? shownPage(doc.id) : 0);

/** Há documento ativo aberto e nenhuma segmentação em andamento. */
export const canSegment = () => {
  const doc = activeDoc();
  return !!doc && !doc.error && useSubject.getState().phase.kind === "idle";
};

/** Inverso de uma máscara bitmap: as corridas trocam de lado (começam sempre por "fora"). */
export function invertBitmap(m: Mask & { type: "bitmap" }): Mask & { type: "bitmap" } {
  const { rle } = m.data;
  return { type: "bitmap", data: { ...m.data, rle: rle[0] === 0 ? rle.slice(1) : [0, ...rle] } };
}

let answer: ((ok: boolean) => void) | null = null;

/** Resposta do diálogo "baixar o modelo?". */
export function answerDownload(ok: boolean) {
  answer?.(ok);
  answer = null;
}

/** Incrementa a cada execução e a cada cancelamento: resultados de execuções velhas são descartados. */
let run = 0;

export function cancelSubject() {
  run++;
  answerDownload(false);
  setPhase({ kind: "idle" });
  void ipc.segmentCancel().catch(() => {});
}

/** Máscara do sujeito da página `page`, ou `null` (cancelado, recusado, documento ou página mudou). */
async function subjectOf(doc: DocInfo, page: number): Promise<(Mask & { type: "bitmap" }) | null> {
  const token = ++run;
  const ready = await ipc.segmentModelReady();
  if (!ready) {
    setPhase({ kind: "ask" });
    const ok = await new Promise<boolean>((r) => (answer = r));
    if (!ok || token !== run) {
      if (token === run) setPhase({ kind: "idle" });
      return null;
    }
  }
  setPhase({ kind: "busy", downloading: !ready });
  try {
    const mask = await ipc.segmentSubject(doc.id, page);
    const now = activeDoc();
    // Cancelado, ou o documento mudou (outra op, documento ou página) enquanto a máscara era calculada.
    if (token !== run || now?.id !== doc.id || now.rev !== doc.rev || mask.type !== "bitmap") return null;
    if (pageOf(doc) !== page) return null;
    return mask;
  } catch (e) {
    if (token !== run) return null;
    if (codeOf(e) === "empty_selection") notify(i18n.t("subject.none"));
    else notifyError(e);
    return null;
  } finally {
    if (token === run) setPhase({ kind: "idle" });
  }
}

/** Ferramentas › Remover Fundo: o fundo fica transparente numa só operação (desfazível). */
export async function removeBackground() {
  const doc = activeDoc();
  const page = pageOf(doc);
  const mask = doc && (await subjectOf(doc, page));
  if (!doc || !mask) return;
  useSelection.getState().setSelection(null);
  await useDocs.getState().applyOp(doc.id, { type: "makeTransparent", data: invertBitmap(mask) }, page);
}

/** Seleciona o sujeito (a seleção serve para Recortar, Apagar, Copiar...). */
export async function selectSubject(): Promise<Mask | null> {
  const doc = activeDoc();
  const mask = doc && (await subjectOf(doc, pageOf(doc)));
  if (!mask) return null;
  useSelection.getState().setSelection(mask);
  return mask;
}

/** Copiar Objeto: seleciona o sujeito e o põe na área de transferência (fundo transparente). */
export async function copySubject() {
  const doc = activeDoc();
  const page = pageOf(doc);
  const mask = await selectSubject();
  if (doc && mask) await ipc.copyRegion(doc.id, mask, page);
}
