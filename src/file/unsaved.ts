import type { DocInfo } from "../ipc/types";

export type CloseChoice = "discard" | "cancel";

/**
 * Pergunta o que fazer antes de fechar documentos com alterações.
 * Stub: a Task 11 implementa o diálogo. Até lá, nunca descarta alterações sem perguntar.
 */
export async function confirmClose(docs: DocInfo[]): Promise<CloseChoice> {
  return docs.some((d) => d.dirty) ? "cancel" : "discard";
}
