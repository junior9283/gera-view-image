import { useDocs } from "../store/docs";
import type { DocId } from "../ipc/types";

/**
 * Desfazer/Refazer global. O provedor padrão usa só as `Op` do documento
 * (Rust). A Marcação troca o provedor por uma pilha unificada que intercala
 * anotações e `Op` (ver `setHistoryProvider`). Menus e atalhos chamam só
 * `undo()`/`redo()` daqui.
 */
export interface HistoryProvider {
  undo(id: DocId): Promise<void>;
  redo(id: DocId): Promise<void>;
  canUndo(id: DocId): boolean;
  canRedo(id: DocId): boolean;
  /** Avisa quando `canUndo`/`canRedo` podem ter mudado fora do store de documentos. */
  subscribe?(cb: () => void): () => void;
}

export const opsHistory: HistoryProvider = {
  undo: async (id) => {
    await useDocs.getState().undo(id);
  },
  redo: async (id) => {
    await useDocs.getState().redo(id);
  },
  canUndo: (id) => (useDocs.getState().docs.find((d) => d.id === id)?.canUndo ?? false),
  canRedo: (id) => (useDocs.getState().docs.find((d) => d.id === id)?.canRedo ?? false),
};

let provider: HistoryProvider = opsHistory;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
let offProvider: (() => void) | undefined;

export function setHistoryProvider(p: HistoryProvider | null): void {
  offProvider?.();
  provider = p ?? opsHistory;
  offProvider = provider.subscribe?.(notify);
  notify();
}

/** Para menus/atalhos reativos (`useEnabled`): muda com o provedor e com a pilha dele. */
export function subscribeHistory(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const undo = (id: DocId) => provider.undo(id);
export const redo = (id: DocId) => provider.redo(id);
export const canUndo = (id: DocId) => provider.canUndo(id);
export const canRedo = (id: DocId) => provider.canRedo(id);
