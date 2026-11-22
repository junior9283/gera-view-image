import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../ipc/commands";
import { DOC_UPDATED_EVENT, type DocId, type DocInfo, type Op } from "../ipc/types";
import { useUi } from "./ui";

interface DocsState {
  docs: DocInfo[];
  activeId: DocId | null;
  open: (paths: string[]) => Promise<DocInfo[]>;
  /** Acrescenta documentos já abertos no Rust (ex.: `startupDocuments`), ignorando ids repetidos. */
  add: (infos: DocInfo[]) => void;
  /** Substitui o DocInfo, ignorando revisões mais antigas que a atual. */
  update: (info: DocInfo) => void;
  setActive: (id: DocId) => void;
  /** Move o documento `id` para a posição `to`. */
  reorder: (id: DocId, to: number) => void;
  /** Reordena pela lista de ids (ordem de Ordenar Por); ids que faltam ficam no fim, como estão. */
  applyOrder: (ids: DocId[]) => void;
  /** Fecha no Rust e remove; se era o ativo, ativa o seguinte (ou o anterior). Não pergunta nada. */
  close: (id: DocId) => Promise<void>;
  applyOp: (id: DocId, op: Op) => Promise<DocInfo>;
  undo: (id: DocId) => Promise<DocInfo>;
  redo: (id: DocId) => Promise<DocInfo>;
}

/** `doc-updated` de documentos que ainda não chegaram ao store (o evento pode vencer a resposta do IPC). */
const early = new Map<DocId, DocInfo>();
const newest = (a: DocInfo, b: DocInfo | undefined) => (b && b.rev >= a.rev ? b : a);

export const useDocs = create<DocsState>((set, get) => {
  const replaceWith = async (p: Promise<DocInfo>) => {
    const info = await p;
    get().update(info);
    return info;
  };
  return {
    docs: [],
    activeId: null,
    open: async (paths) => {
      const infos = await ipc.openDocuments(paths);
      get().add(infos);
      return infos;
    },
    add: (infos) =>
      set((s) => {
        const have = new Set(s.docs.map((d) => d.id));
        const fresh = infos
          .filter((d) => !have.has(d.id) && have.add(d.id))
          .map((d) => {
            const e = early.get(d.id);
            early.delete(d.id);
            return newest(d, e);
          });
        if (!fresh.length) return s;
        return { docs: [...s.docs, ...fresh], activeId: s.activeId ?? fresh[0].id };
      }),
    update: (info) => {
      if (!get().docs.some((d) => d.id === info.id)) {
        early.set(info.id, newest(info, early.get(info.id)));
        return;
      }
      set((s) => ({ docs: s.docs.map((d) => (d.id === info.id && info.rev >= d.rev ? info : d)) }));
    },
    setActive: (id) => set({ activeId: id }),
    reorder: (id, to) =>
      set((s) => {
        const from = s.docs.findIndex((d) => d.id === id);
        if (from < 0) return s;
        const docs = [...s.docs];
        const [moved] = docs.splice(from, 1);
        docs.splice(Math.max(0, Math.min(to, docs.length)), 0, moved);
        return { docs };
      }),
    applyOrder: (ids) =>
      set((s) => {
        const rank = new Map(ids.map((id, i) => [id, i]));
        const docs = [...s.docs].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
        return docs.every((d, i) => d === s.docs[i]) ? s : { docs };
      }),
    close: async (id) => {
      await ipc.closeDocument(id);
      early.delete(id);
      // O documento que assume o lugar abre na página padrão dele.
      if (get().activeId === id) useUi.getState().setPage(null);
      set((s) => {
        const i = s.docs.findIndex((d) => d.id === id);
        if (i < 0) return s;
        const docs = s.docs.filter((d) => d.id !== id);
        const activeId = s.activeId !== id ? s.activeId : (docs[Math.min(i, docs.length - 1)]?.id ?? null);
        return { docs, activeId };
      });
    },
    applyOp: (id, op) => replaceWith(ipc.applyOp(id, op)),
    undo: (id) => replaceWith(ipc.undo(id)),
    redo: (id) => replaceWith(ipc.redo(id)),
  };
});

// A página escolhida precisa existir no documento ativo (Reverter e Restaurar podem ter menos).
useDocs.subscribe(({ docs, activeId }) => {
  const { page, setPage } = useUi.getState();
  const doc = docs.find((d) => d.id === activeId);
  if (page !== null && doc && page >= doc.frames) setPage(null);
});

let init: Promise<void> | null = null;

/**
 * Liga o `doc-updated` e só então busca os documentos de `argv`; assim nenhuma atualização se
 * perde entre as duas coisas. Idempotente: o StrictMode monta os efeitos duas vezes.
 */
export function initDocs(): Promise<void> {
  return (init ??= (async () => {
    await listen<DocInfo>(DOC_UPDATED_EVENT, (e) => useDocs.getState().update(e.payload));
    useDocs.getState().add(await ipc.startupDocuments());
  })());
}

/** Só para testes. */
export function resetDocsForTests(): void {
  init = null;
  early.clear();
  useDocs.setState({ docs: [], activeId: null });
}
