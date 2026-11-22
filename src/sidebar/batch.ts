// Ações em lote sobre a seleção da barra lateral (girar, espelhar, Ajustar Cor/Tamanho).
// Cada imagem recebe a própria `apply_op` (e, portanto, o próprio desfazer); uma falha não para as
// outras e o resultado é relatado por arquivo; a interface respira entre uma imagem e a seguinte.
import { create } from "zustand";
import { notify } from "../chrome/notify";
import i18n from "../i18n";
import type { DocId, DocInfo, Op } from "../ipc/types";
import { useDocs } from "../store/docs";

export interface BatchFailure {
  id: DocId;
  name: string;
  error: string;
}

export interface BatchResult {
  total: number;
  done: number;
  failed: BatchFailure[];
}

interface BatchState {
  running: boolean;
  done: number;
  total: number;
}

/** Progresso do lote em andamento (a barra lateral mostra e bloqueia outro lote). */
export const useBatch = create<BatchState>(() => ({ running: false, done: 0, total: 0 }));

/** Cede a vez ao navegador para pintar e tratar eventos. */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
};

const t = (k: string, o: Record<string, unknown> = {}) => i18n.t(k, o);

/** Roda `work` em cada id, em sequência. Erros viram `failed`; nunca interrompem os demais. */
export async function runBatch(ids: DocId[], work: (id: DocId) => Promise<unknown>): Promise<BatchResult> {
  if (useBatch.getState().running) {
    notify(t("sidebar.batch.busy"));
    return { total: 0, done: 0, failed: [] };
  }
  const result: BatchResult = { total: ids.length, done: 0, failed: [] };
  useBatch.setState({ running: true, done: 0, total: ids.length });
  try {
    for (const [i, id] of ids.entries()) {
      try {
        await work(id);
        result.done++;
      } catch (e) {
        console.error(e);
        const name = useDocs.getState().docs.find((d) => d.id === id)?.name ?? String(id);
        result.failed.push({ id, name, error: messageOf(e) });
      }
      useBatch.setState({ done: i + 1 });
      if (i < ids.length - 1) await yieldToUi();
    }
  } finally {
    useBatch.setState({ running: false, done: 0, total: 0 });
  }
  return result;
}

const MAX_NAMES = 3;

/** Um aviso só: nada para uma imagem que deu certo; com falhas, quantas e quais (os primeiros nomes). */
export function reportBatch(r: BatchResult): void {
  if (r.failed.length) {
    const names = r.failed.slice(0, MAX_NAMES).map((f) => f.name);
    const more = r.failed.length - names.length;
    notify(t("sidebar.batch.failed", { done: r.done, total: r.total, names: names.join(", ") + (more > 0 ? ` +${more}` : "") }));
  } else if (r.total > 1) {
    notify(t("sidebar.batch.done", { count: r.done }));
  }
}

/**
 * Aplica a op de cada imagem (`op(doc)`) e relata o resultado. Uma imagem só segue o caminho
 * simples de sempre (sem trava de lote, para teclas repetidas, e com o erro propagado).
 */
export async function applyToTargets(ids: DocId[], op: (d: DocInfo) => Op): Promise<BatchResult> {
  const docs = useDocs.getState();
  if (ids.length === 1) {
    const d = docs.docs.find((x) => x.id === ids[0]);
    if (!d) throw new Error("documento fechado");
    await docs.applyOp(d.id, op(d));
    return { total: 1, done: 1, failed: [] };
  }
  const result = await runBatch(ids, async (id) => {
    const d = useDocs.getState().docs.find((x) => x.id === id);
    if (!d) throw new Error("documento fechado");
    await useDocs.getState().applyOp(id, op(d));
  });
  reportBatch(result);
  return result;
}

export type ResizeMode = "exact" | "fit" | "ratio";

/**
 * Tamanho de `d` para um Ajustar Tamanho em lote. `box` é o tamanho escolhido para o documento
 * ativo (`orig`): "exact" copia o tamanho; "fit" cabe na caixa mantendo a proporção; "ratio"
 * (unidade %) repete a razão do ativo.
 */
export function resizeFor(
  d: Pick<DocInfo, "width" | "height">,
  box: { w: number; h: number },
  orig: { w: number; h: number },
  mode: ResizeMode,
): { w: number; h: number } {
  if (mode === "exact") return { w: box.w, h: box.h };
  const k = mode === "ratio" ? box.w / orig.w : Math.min(box.w / d.width, box.h / d.height);
  return { w: Math.max(1, Math.round(d.width * k)), h: Math.max(1, Math.round(d.height * k)) };
}
