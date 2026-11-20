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

export function setHistoryProvider(p: HistoryProvider | null): void {
  provider = p ?? opsHistory;
}

export const undo = (id: DocId) => provider.undo(id);
export const redo = (id: DocId) => provider.redo(id);
export const canUndo = (id: DocId) => provider.canUndo(id);
export const canRedo = (id: DocId) => provider.canRedo(id);
