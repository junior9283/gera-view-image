// Fechar a janela e sair: pergunta por cada documento não salvo e só então sela a janela no Rust,
// que recusa fechar uma não selada. Ao sair, cada janela responde; um Cancelar desfaz tudo.
import { notifyError } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { confirmAndSave } from "../file/unsaved";
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { setVeil } from "./store";
import { busy, commitEditing, moveDocs, receiveDocs } from "./transfer";

/**
 * Pergunta pelos não salvos até não sobrar nenhum sem resposta: o que mudou enquanto os outros
 * eram salvos também é perguntado. `false` = cancelou, ou um não pôde ser salvo.
 */
async function settleEdits(): Promise<boolean> {
  commitEditing();
  const answered = new Map<DocId, number>();
  for (;;) {
    const pending = useDocs.getState().docs.filter((d) => hasUnsaved(d) && answered.get(d.id) !== d.rev);
    if (!pending.length) return true;
    if (!(await confirmAndSave(pending))) return false;
    for (const d of useDocs.getState().docs) if (pending.some((p) => p.id === d.id)) answered.set(d.id, d.rev);
  }
}

/** Sela, com o véu, sem perguntar; `false` = chegaram documentos, já recebidos. */
async function trySeal(): Promise<boolean> {
  setVeil("closing");
  let sealed = false;
  try {
    sealed = await ipc.sealWindow();
  } finally {
    if (!sealed) setVeil(null);
  }
  if (!sealed) await receiveDocs();
  return sealed;
}

async function closeSealed(): Promise<void> {
  try {
    await ipc.closeWindow();
  } catch (e) {
    await ipc.unsealWindow().catch(() => {});
    setVeil(null);
    throw e;
  }
}

async function seal(): Promise<boolean> {
  while (await settleEdits()) if (await trySeal()) return true;
  return false;
}

let sealing: Promise<boolean> | null = null;

/** Um fechamento por vez: pedidos repetidos esperam a mesma resposta. */
const sealOnce = () => (sealing ??= seal().finally(() => (sealing = null)));

/** Fecha esta janela (botão, Fechar Janela, gerenciador de janelas). */
export async function closeThisWindow(): Promise<void> {
  if (await sealOnce()) await closeSealed();
}

/** Outra janela juntou todas nela: manda tudo e, vazia, fecha. */
export async function sendAllTo(label: string): Promise<void> {
  const ids = useDocs.getState().docs.map((d) => d.id);
  if (ids.length && !(await moveDocs(ids, (list, state) => ipc.moveDocuments(list, label, state)))) return;
  if (useDocs.getState().docs.length || busy()) return;
  if (await trySeal()) await closeSealed();
}

/** Pergunta em todas as janelas e, com todas de acordo, faz `leave`; `false` = alguém cancelou. */
export async function quitWith(leave: () => Promise<void>): Promise<boolean> {
  if (!(await ipc.confirmQuit())) return false;
  try {
    await leave();
  } catch (e) {
    await ipc.cancelQuit().catch(() => {});
    throw e;
  }
  return true;
}

/** Sair do app. */
export const quit = () => quitWith(ipc.quitApp);

/** O app está saindo: responde por esta janela. */
export async function answerQuit(): Promise<void> {
  let ok = false;
  try {
    ok = await sealOnce();
  } catch (e) {
    notifyError(e);
  }
  await ipc.answerClose(ok);
}

/** A saída foi cancelada (o Rust já desfez o selo). */
export const quitCancelled = () => setVeil(null);
