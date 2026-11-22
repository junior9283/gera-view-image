// Comandos em andamento por documento. Mover um documento de janela (Lote 12) espera os que o
// alteram terminarem: a resposta (novo `DocInfo`, passo do desfazer) é desta janela.
import type { DocId } from "./types";

/**
 * Só leem, e o resultado não é aplicado ao documento: não precisam terminar antes de mover (e alguns
 * demoram). `segment_subject` fica de fora: Remover Fundo o usa. Um comando novo conta como alteração.
 */
const READ_ONLY = new Set([
  "render_view", "thumbnail", "metadata", "histogram", "auto_levels", "preview_adjust", "instant_alpha", "snap_lasso",
  "estimate_size", "document_dpi", "document_profile", "recognize_text", "detect_codes",
  "file_tags", "file_locked", "file_stats", "list_versions", "version_preview", "open_with_apps",
]);

const running = new Map<DocId, number>();

const idsOf = (args: unknown): DocId[] => {
  const a = args as { id?: unknown; ids?: unknown } | undefined;
  return [a?.id, ...(Array.isArray(a?.ids) ? a.ids : [])].filter((x): x is DocId => typeof x === "number");
};

/** Conta o comando enquanto a promessa não termina. */
export function track<T>(command: string, args: unknown, result: Promise<T>): Promise<T> {
  const ids = READ_ONLY.has(command) ? [] : idsOf(args);
  if (!ids.length) return result;
  for (const id of ids) running.set(id, (running.get(id) ?? 0) + 1);
  const done = () => {
    for (const id of ids) {
      const n = (running.get(id) ?? 1) - 1;
      if (n) running.set(id, n);
      else running.delete(id);
    }
  };
  Promise.resolve(result).then(done, done);
  return result;
}

const busy = (ids: DocId[]) => ids.some((id) => running.has(id));
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Espera não haver comando em andamento nesses documentos, dando tempo às continuações (que podem
 * começar outro). `false` = não terminou em `timeoutMs`.
 */
export async function whenIdle(ids: DocId[], timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await tick(0);
    if (!busy(ids)) {
      await tick(0);
      if (!busy(ids)) return true;
    }
    if (Date.now() >= end) return false;
    await tick(30);
  }
}
