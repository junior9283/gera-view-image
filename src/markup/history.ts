// Pilha unificada de desfazer: intercala ações de anotação e `Op` do Rust, na ordem
// (timestamp) em que aconteceram. Fica registrada como provedor de `src/edit/history.ts`;
// menus e atalhos só chamam `undo`/`redo` de lá.
import { opsHistory, setHistoryProvider, type HistoryProvider } from "../edit/history";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import type { Annotation } from "./model";
import { getItems, useMarkup } from "./store";

type Entry = { ts: number } & (
  | { kind: "markup"; before: Annotation[]; after: Annotation[] }
  /** `Op` aplicada no Rust (o Rust guarda a própria pilha; aqui só a posição na ordem). */
  | { kind: "op" }
  /** Anotações achatadas com `Op::Composite`: desfazer volta a `Op` e devolve as anotações. */
  | { kind: "flatten"; before: Annotation[] }
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

function record(id: DocId, e: Entry): void {
  const s = of(id);
  s.undo.push(e);
  s.redo = [];
}

export const pushMarkup = (id: DocId, before: Annotation[], after: Annotation[]) =>
  record(id, { ts: Date.now(), kind: "markup", before, after });
export const pushOp = (id: DocId) => record(id, { ts: Date.now(), kind: "op" });
export const pushFlatten = (id: DocId, before: Annotation[]) => record(id, { ts: Date.now(), kind: "flatten", before });

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
    }
    return;
  }
  try {
    if (e.kind !== "markup") await useDocs.getState()[dir](id);
  } catch (err) {
    from.push(e);
    throw err;
  }
  if (e.kind === "markup") setItems(id, dir === "undo" ? e.before : e.after);
  else if (e.kind === "flatten") setItems(id, dir === "undo" ? e.before : []);
  to.push(e);
}

export const undo = (id: DocId) => serial(id, () => step(id, "undo"));
export const redo = (id: DocId) => serial(id, () => step(id, "redo"));
export const canUndo = (id: DocId) => of(id).undo.length > 0 || opsHistory.canUndo(id);
export const canRedo = (id: DocId) => of(id).redo.length > 0;

export const unifiedHistory: HistoryProvider = { undo, redo, canUndo, canRedo };

/** Esquece a pilha (documento fechado). */
export function forget(id: DocId): void {
  stacks.delete(id);
  chains.delete(id);
}

/**
 * Registra a pilha unificada como provedor global e passa a anotar na ordem as `Op`
 * aplicadas por `useDocs.applyOp`. Documentos fechados perdem pilha e anotações.
 * Devolve a função que desfaz tudo isso.
 */
export function installHistory(): () => void {
  const orig = useDocs.getState().applyOp;
  const tracked: typeof orig = async (id, op) => {
    const info = await orig(id, op);
    pushOp(id);
    return info;
  };
  useDocs.setState({ applyOp: tracked });
  setHistoryProvider(unifiedHistory);
  const off = useDocs.subscribe((s, prev) => {
    if (s.docs === prev.docs) return;
    const open = new Set(s.docs.map((d) => d.id));
    for (const d of prev.docs) {
      if (open.has(d.id)) continue;
      forget(d.id);
      if (getItems(d.id).length) useMarkup.getState().drop(d.id);
    }
  });
  return () => {
    off();
    if (useDocs.getState().applyOp === tracked) useDocs.setState({ applyOp: orig });
    setHistoryProvider(null);
  };
}

/** Só para testes. */
export function resetHistoryForTests(): void {
  stacks.clear();
  chains.clear();
}
