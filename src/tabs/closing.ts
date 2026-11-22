// Fechar a janela e sair: pergunta por cada documento não salvo e só então sela a janela no Rust,
// que recusa fechar uma não selada. Ao sair, cada janela responde; um Cancelar desfaz tudo.
import { notify, notifyError } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { confirmClose, saveAll } from "../file/unsaved";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import { whenAllIdle } from "../ipc/inflight";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { ask, putVeil } from "./store";
import { busy, commitEditing, isMoving, moveDocs, movesDone, receiveDocs } from "./transfer";

/** Tempo para uma gravação ou edição em andamento terminar antes de perguntar. */
const RUNNING_GRACE_MS = 1500;

/**
 * Impressão, exportação ou edição em andamento: espera, e se demorar pergunta se fecha assim mesmo
 * (terminando com a pergunta aberta, segue sozinha). `false` = ficar.
 */
async function operationsDone(): Promise<boolean> {
  const end = Date.now() + RUNNING_GRACE_MS;
  if (await whenAllIdle(() => Date.now() >= end)) return true;
  let answered = false;
  const t = (k: string) => i18n.t(`tabs.running.${k}`);
  const ok = await ask(
    { title: t("title"), body: t("body"), ok: t("close"), cancel: t("wait") },
    whenAllIdle(() => answered),
  );
  answered = true;
  return ok;
}

/**
 * Pergunta pelos não salvos até não sobrar nenhum sem resposta. Vale como respondido só o descartado,
 * na versão em que foi: um salvo que voltou a mudar é perguntado de novo. `false` = cancelou, ou um
 * não pôde ser salvo.
 */
async function settleEdits(): Promise<boolean> {
  const discarded = new Map<DocId, number>();
  for (;;) {
    const pending = useDocs.getState().docs.filter((d) => hasUnsaved(d) && discarded.get(d.id) !== d.rev);
    if (!pending.length) return true;
    const choice = await confirmClose(pending);
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveAll(pending))) return false;
    if (choice === "discard") {
      for (const d of useDocs.getState().docs) if (pending.some((p) => p.id === d.id)) discarded.set(d.id, d.rev);
    }
  }
}

/** Janela selada, com o véu dela. `round`: rodada da saída, ou `null` se ela mesma está fechando. */
let sealed: { release: () => void; round: number | null } | null = null;

function setSealed(release: () => void, round: number | null): void {
  unveil();
  sealed = { release, round };
}

function unveil(): void {
  sealed?.release();
  sealed = null;
}

/** Sela, com o véu, sem perguntar; `false` = chegaram documentos, já recebidos. */
async function trySeal(quit: number | null): Promise<boolean> {
  const release = putVeil("closing");
  const ok = await ipc.sealWindow(quit).catch((e: unknown) => {
    release();
    throw e;
  });
  if (ok) {
    setSealed(release, quit);
    return true;
  }
  release();
  await receiveDocs();
  return false;
}

async function closeSealed(): Promise<void> {
  try {
    await ipc.closeWindow();
  } catch (e) {
    await ipc.unsealWindow().catch(() => {});
    unveil();
    throw e;
  }
}

/** A janela vai fechar por si (e não só concordar com a saída). */
let closing = false;
/** Última rodada da saída em que esta janela foi perguntada. */
let quitRound = 0;

async function seal(): Promise<boolean> {
  let running = true;
  for (;;) {
    commitEditing();
    await movesDone();
    // Quem já escolheu fechar assim mesmo não é perguntado de novo.
    if (running && !(await operationsDone())) return false;
    running = false;
    if (!(await settleEdits())) return false;
    if (isMoving()) continue;
    if (await trySeal(closing ? null : quitRound)) return true;
  }
}

let sealing: Promise<boolean> | null = null;

/** Um fechamento por vez: pedidos repetidos esperam a mesma resposta. */
const sealOnce = () => (sealing ??= seal().finally(() => (sealing = null)));

/** Fecha esta janela (botão, Fechar Janela, gerenciador de janelas). */
export async function closeThisWindow(): Promise<void> {
  closing = true;
  try {
    if (await sealOnce()) await closeSealed();
  } finally {
    closing = false;
  }
}

/** Outra janela juntou todas nela: manda tudo e, vazia, fecha. Se não puder, avisa quem pediu. */
export async function sendAllTo(label: string): Promise<void> {
  const decline = () => ipc.declineMerge(label).catch(() => {});
  const ids = useDocs.getState().docs.map((d) => d.id);
  if (sealing) return decline();
  if (ids.length && !(await moveDocs(ids, (list, state) => ipc.moveDocuments(list, label, state)))) return decline();
  if (useDocs.getState().docs.length || busy() || sealing) return decline();
  if (await trySeal(null)) await closeSealed();
}

/** Janela que não responde: sair sem ela é escolha explícita (as alterações dela se perdem). */
function leaveWithout(name: string): Promise<boolean> {
  const t = (k: string) => i18n.t(`tabs.unresponsive.${k}`, { name });
  return ask({ title: t("title"), body: t("body"), ok: t("leave"), cancel: t("cancel") });
}

/** Pergunta em todas as janelas e, com todas de acordo, faz `leave`; `false` = alguém cancelou. */
export async function quitWith(leave: () => Promise<void>): Promise<boolean> {
  const skip: string[] = [];
  for (;;) {
    const out = await ipc.confirmQuit([...skip]);
    if (out.kind === "agreed") break;
    if (out.kind === "opening") notify(i18n.t("tabs.stillOpening", { name: out.title }));
    if (out.kind !== "unresponsive" || !(await leaveWithout(out.title))) return false;
    skip.push(out.label);
  }
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

let answering = false;

/**
 * O app está saindo: responde por esta janela. Se a saída foi cancelada com a pergunta aberta e
 * pedida de novo, a mesma resposta vale, uma vez só, para a rodada mais nova.
 */
export async function answerQuit(round: number): Promise<void> {
  quitRound = Math.max(quitRound, round);
  if (answering) return;
  answering = true;
  let ok = false;
  try {
    ok = await sealOnce();
  } catch (e) {
    notifyError(e);
  } finally {
    answering = false;
  }
  const asked = quitRound;
  if (ok && !closing) setSealed(putVeil("quitting"), asked);
  await ipc.answerClose(asked, ok);
}

/** A saída da rodada foi cancelada (o Rust já desfez o selo dela). */
export function quitCancelled(round: number): void {
  if (sealed && sealed.round !== null && sealed.round <= round) unveil();
}

/** Só para testes. */
export function resetClosingForTests(): void {
  sealed = null;
  sealing = null;
  closing = false;
  answering = false;
  quitRound = 0;
}
