import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo, Op } from "../ipc/types";

interface DocsState {
  docs: DocInfo[];
  activeId: DocId | null;
  open: (paths: string[]) => Promise<DocInfo[]>;
  /** Acrescenta documentos já abertos no Rust (ex.: `startupDocuments`). */
  add: (infos: DocInfo[]) => void;
  /** Substitui o DocInfo, ignorando revisões mais antigas que a atual. */
  update: (info: DocInfo) => void;
  setActive: (id: DocId) => void;
  applyOp: (id: DocId, op: Op) => Promise<DocInfo>;
  undo: (id: DocId) => Promise<DocInfo>;
  redo: (id: DocId) => Promise<DocInfo>;
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
      set((s) => ({ docs: [...s.docs, ...infos], activeId: s.activeId ?? infos[0]?.id ?? null })),
    update: (info) =>
      set((s) => ({ docs: s.docs.map((d) => (d.id === info.id && info.rev >= d.rev ? info : d)) })),
    setActive: (id) => set({ activeId: id }),
    applyOp: (id, op) => replaceWith(ipc.applyOp(id, op)),
    undo: (id) => replaceWith(ipc.undo(id)),
    redo: (id) => replaceWith(ipc.redo(id)),
  };
});
