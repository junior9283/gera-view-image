// Passar documentos para outra janela e receber os que chegam. A posse muda no Rust de uma vez; a
// interface só esquece o documento depois de o Rust confirmar, e só mostra depois de retirá-lo.
import { notify, notifyError } from "../chrome/notify";
import { hasUncarried } from "../file/dirty";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import { whenIdle } from "../ipc/inflight";
import type { DocId, Mask } from "../ipc/types";
import { dropDocs, dumpDocs, loadDocs, pack, settleDocs, unpack, type DocStates } from "../lib/docState";
import { useBatch } from "../sidebar/batch";
import { effectiveSelection, useThumbSelection } from "../sidebar/selection";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { setVeil, useTabs } from "./store";

interface TransferState {
  docs: DocStates;
  /** O documento ativo, se foi junto, com o que só ele tem. */
  active: { id: DocId; page: number | null; selection: Mask | null } | null;
}

/** Espera pelos comandos em andamento antes de desistir de mover. */
export const IDLE_TIMEOUT_MS = 15_000;

/** Diálogo, painel com edição não aplicada, lote ou apresentação: nada muda de janela. */
export const busy = () =>
  useTabs.getState().veil !== null || useBatch.getState().running || useUi.getState().slideshow ||
  !!document.querySelector('[aria-modal="true"], .adjust-panel');

function collect(ids: DocId[]): string {
  const { activeId } = useDocs.getState();
  const state: TransferState = {
    docs: dumpDocs(ids),
    active:
      activeId !== null && ids.includes(activeId)
        ? { id: activeId, page: useUi.getState().page, selection: useSelection.getState().selection }
        : null,
  };
  return pack(state);
}

/** Texto em edição numa anotação ou campo só é confirmado ao perder o foco. */
export function commitEditing(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** Primeiro documento com alteração que não há como levar. */
function refuseUncarried(ids: DocId[]): boolean {
  const d = useDocs.getState().docs.find((x) => ids.includes(x.id) && hasUncarried(x.id));
  if (d) notify(i18n.t("tabs.pending", { name: d.name }));
  return !!d;
}

/** Leva os documentos para outra janela por `deliver`; `false` = nada mudou (o usuário foi avisado). */
export async function moveDocs(ids: DocId[], deliver: (ids: DocId[], state: string) => Promise<unknown>): Promise<boolean> {
  if (busy()) {
    notify(i18n.t("tabs.busy"));
    return false;
  }
  commitEditing();
  setVeil("moving");
  try {
    await settleDocs(ids);
    if (!(await whenIdle(ids, IDLE_TIMEOUT_MS))) {
      notify(i18n.t("tabs.timeout"));
      return false;
    }
    if (refuseUncarried(ids)) return false;
    await deliver(ids, collect(ids));
    useDocs.getState().detach(ids);
    dropDocs(ids);
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  } finally {
    setVeil(null);
  }
}

/** O que Mover Aba para Nova Janela leva: a seleção de miniaturas, ou só a aba ativa. */
export function movable(): DocId[] {
  const { docs, activeId } = useDocs.getState();
  const ids = effectiveSelection(docs, activeId, useThumbSelection.getState().picked);
  // Levar tudo só trocaria a janela.
  return ids.length < docs.length ? ids : [];
}

export async function moveTabToNewWindow(): Promise<void> {
  const ids = movable();
  if (ids.length) await moveDocs(ids, ipc.newWindow);
}

/** Juntar Todas as Janelas nesta: as outras mandam seus documentos e se fecham. */
export async function mergeAllWindows(): Promise<void> {
  await ipc.mergeWindows();
  setPrefs({ tabBar: true });
}

function parse(text: string): TransferState | null {
  try {
    return unpack(text) as TransferState;
  } catch (e) {
    console.error("estado dos documentos recebidos:", e);
    return null;
  }
}

/** Recebe os documentos entregues a esta janela e mostra o que estava ativo na de origem. */
export async function receiveDocs(): Promise<void> {
  for (const { infos, state } of (await ipc.takeDocuments()) ?? []) {
    const s = parse(state);
    if (s) loadDocs(s.docs);
    useDocs.getState().add(infos);
    const active = infos.find((d) => d.id === s?.active?.id) ?? infos[0];
    if (!active) continue;
    activate(active.id, s?.active?.page ?? null);
    // Depois de ativar: trocar de documento limpa a seleção.
    if (s?.active?.id === active.id) useSelection.getState().setSelection(s.active.selection ?? null);
  }
}
