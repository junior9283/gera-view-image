// Pilha unificada de desfazer: intercala ações de anotação e `Op` do Rust, na ordem
// (timestamp) em que aconteceram. Fica registrada como provedor de `src/edit/history.ts`;
// menus e atalhos só chamam `undo`/`redo` de lá.
import { opsHistory, setHistoryProvider, type HistoryProvider } from "../edit/history";
import type { DocId } from "../ipc/types";
import { registerDocState } from "../lib/docState";
import { useDocs } from "../store/docs";
import { transformForOp, type Annotation } from "./model";
import { onPage, pageSize, shownPage } from "./pages";
import { getItems, useMarkup } from "./store";

/** Anotações antes e depois de um passo. */
export interface ItemsChange { before: Annotation[]; after: Annotation[] }

type Entry = { ts: number } & (
  | ({ kind: "markup" } & ItemsChange)
  /**
   * `Op` aplicada no Rust (o Rust guarda a própria pilha; aqui só a posição na ordem).
   * `items`: anotações que mudaram junto (girar/recortar as leva; achatar as consome).
   */
  | { kind: "op"; items?: ItemsChange }
);

interface Stacks { undo: Entry[]; redo: Entry[] }

const stacks = new Map<DocId, Stacks>();
/** Uma ação por vez em cada documento (desfazer rápido não embaralha a ordem com o IPC). */
const chains = new Map<DocId, Promise<void>>();

function of(id: DocId): Stacks {
  let s = stacks.get(id);
  if (!s) stacks.set(id, (s = { undo: [], redo: [] }));
  return s;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function record(id: DocId, e: Entry): void {
  const s = of(id);
  s.undo.push(e);
  s.redo = [];
  notify();
}

export const pushMarkup = (id: DocId, before: Annotation[], after: Annotation[]) =>
  record(id, { ts: Date.now(), kind: "markup", before, after });
export const pushOp = (id: DocId, items?: ItemsChange) => record(id, { ts: Date.now(), kind: "op", items });

function serial(id: DocId, f: () => Promise<void>): Promise<void> {
  const next = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(f);
  chains.set(id, next);
  return next;
}

const setItems = (id: DocId, items: Annotation[]) => useMarkup.getState().setItems(id, items);

async function step(id: DocId, dir: "undo" | "redo"): Promise<void> {
  const s = of(id);
  const [from, to] = dir === "undo" ? [s.undo, s.redo] : [s.redo, s.undo];
  const e = from.pop();
  if (!e) {
    // `Op` anteriores à pilha (não deveria haver, mas o Rust é a fonte da verdade).
    if (dir === "undo" && opsHistory.canUndo(id)) {
      await opsHistory.undo(id);
      to.push({ ts: Date.now(), kind: "op" });
      notify();
    }
    return;
  }
  try {
    if (e.kind !== "markup") await useDocs.getState()[dir](id);
  } catch (err) {
    from.push(e);
    throw err;
  }
  const change = e.kind === "markup" ? e : e.items;
  if (change) setItems(id, dir === "undo" ? change.before : change.after);
  to.push(e);
  notify();
}

export const undo = (id: DocId) => serial(id, () => step(id, "undo"));
export const redo = (id: DocId) => serial(id, () => step(id, "redo"));
export const canUndo = (id: DocId) => of(id).undo.length > 0 || opsHistory.canUndo(id);
export const canRedo = (id: DocId) => of(id).redo.length > 0;

export const unifiedHistory: HistoryProvider = {
  undo,
  redo,
  canUndo,
  canRedo,
  subscribe: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** Esquece a pilha do documento (fechado, ou revertido: as `Op` do Rust já sumiram). */
export function forgetHistory(id: DocId): void {
  stacks.delete(id);
  chains.delete(id);
  notify();
}

/**
 * Registra a pilha unificada como provedor global e passa a anotar na ordem as `Op`
 * aplicadas por `useDocs.applyOp` (as geométricas levam as anotações junto). Documentos fechados perdem pilha e anotações.
 * Devolve a função que desfaz tudo isso.
 */
export function installHistory(): () => void {
  const orig = useDocs.getState().applyOp;
  const tracked: typeof orig = async (id, op, page = shownPage(id)) => {
    const doc = useDocs.getState().docs.find((d) => d.id === id);
    const before = getItems(id);
    // Num documento de várias páginas, só as anotações da página mudam com ela.
    const mine = onPage(before, doc, page);
    const { w, h } = doc ? pageSize(doc, page) : { w: 0, h: 0 };
    const moved = doc && mine.length ? transformForOp(mine, op, w, h) : null;
    const byId = new Map(moved?.map((a) => [a.id, a]));
    const after = moved && before.map((a) => byId.get(a.id) ?? a);
    const info = await orig(id, op, page);
    if (after) {
      pushOp(id, { before, after });
      setItems(id, after);
    } else pushOp(id);
    return info;
  };
  useDocs.setState({ applyOp: tracked });
  setHistoryProvider(unifiedHistory);
  // A pilha vai com o documento que muda de janela, depois do desfazer em andamento.
  const offState = registerDocState("history", {
    dump: (id) => stacks.get(id),
    load: (id, data) => {
      stacks.set(id, data as Stacks);
      notify();
    },
    settle: (id) => chains.get(id),
  });
  const off = useDocs.subscribe((s, prev) => {
    if (s.docs === prev.docs) return;
    const open = new Set(s.docs.map((d) => d.id));
    for (const d of prev.docs) {
      if (open.has(d.id)) continue;
      forgetHistory(d.id);
      if (getItems(d.id).length) useMarkup.getState().drop(d.id);
    }
  });
  return () => {
    off();
    offState();
    if (useDocs.getState().applyOp === tracked) useDocs.setState({ applyOp: orig });
    setHistoryProvider(null);
  };
}

/** Só para testes. */
export function resetHistoryForTests(): void {
  stacks.clear();
  chains.clear();
}
