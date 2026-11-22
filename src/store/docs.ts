import { create } from "zustand";
import * as ipc from "../ipc/commands";
import { listenHere } from "../lib/window";
import { DOC_UPDATED_EVENT, type DocId, type DocInfo, type Op } from "../ipc/types";

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
  /** Tira da janela sem fechar no Rust (o documento foi para outra janela). */
  detach: (ids: DocId[]) => void;
  applyOp: (id: DocId, op: Op) => Promise<DocInfo>;
  undo: (id: DocId) => Promise<DocInfo>;
  redo: (id: DocId) => Promise<DocInfo>;
}

/** `doc-updated` de documentos que ainda não chegaram ao store (o evento pode vencer a resposta do IPC). */
const early = new Map<DocId, DocInfo>();
const newest = (a: DocInfo, b: DocInfo | undefined) => (b && b.rev >= a.rev ? b : a);

/** Tira `ids`; se o ativo saiu, ativa o seguinte que ficou (ou o anterior). */
function without(s: DocsState, ids: DocId[]): Pick<DocsState, "docs" | "activeId"> {
  const out = new Set(ids);
  const docs = s.docs.filter((d) => !out.has(d.id));
  if (s.activeId === null || !out.has(s.activeId)) return { docs, activeId: s.activeId };
  const at = s.docs.findIndex((d) => d.id === s.activeId);
  const next = s.docs.slice(at).find((d) => !out.has(d.id)) ?? docs[docs.length - 1];
  return { docs, activeId: next?.id ?? null };
}

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
      get().detach([id]);
    },
    detach: (ids) => {
      ids.forEach((id) => early.delete(id));
      set((s) => (s.docs.some((d) => ids.includes(d.id)) ? without(s, ids) : s));
    },
    applyOp: (id, op) => replaceWith(ipc.applyOp(id, op)),
    undo: (id) => replaceWith(ipc.undo(id)),
    redo: (id) => replaceWith(ipc.redo(id)),
  };
});

let init: Promise<void> | null = null;

/**
 * Liga o `doc-updated` e só então busca os documentos da janela (os de `argv`, na principal);
 * assim nenhuma atualização se perde entre as duas coisas. `adopt` recebe antes os que vieram de
 * outra janela, com o estado deles. Idempotente: o StrictMode monta os efeitos duas vezes.
 */
export function initDocs(adopt?: () => Promise<unknown>): Promise<void> {
  return (init ??= (async () => {
    await listenHere<DocInfo>(DOC_UPDATED_EVENT, (info) => useDocs.getState().update(info));
    await adopt?.();
    useDocs.getState().add(await ipc.startupDocuments());
  })());
}

/** Só para testes. */
export function resetDocsForTests(): void {
  init = null;
  early.clear();
  useDocs.setState({ docs: [], activeId: null });
}
