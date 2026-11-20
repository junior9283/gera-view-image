import { useSyncExternalStore } from "react";
import type { DocId } from "../ipc/types";

export interface AnnotationItem {
  id: string;
  /** Tipo da anotação (`text`, `rect`, `arrow`...); só serve de dica visual. */
  kind: string;
  /** Texto curto para a lista (ex.: o conteúdo de um texto). */
  label: string;
}

/** O modelo de anotações (Task 8) implementa esta interface e chama `setAnnotationSource`. */
export interface AnnotationListSource {
  list(docId: DocId): AnnotationItem[];
  /** Avisa mudanças na lista; devolve a função que cancela. */
  subscribe(cb: () => void): () => void;
  /** Seleciona a anotação na tela. */
  select(docId: DocId, annotationId: string): void;
}

let source: AnnotationListSource | null = null;
const listeners = new Set<() => void>();

let offSource: (() => void) | undefined;

const notify = () => listeners.forEach((l) => l());

export function setAnnotationSource(next: AnnotationListSource | null) {
  offSource?.();
  source = next;
  offSource = next?.subscribe(notify);
  notify();
}

export const getAnnotationSource = () => source;

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: AnnotationItem[] = [];
let cache: { src: AnnotationListSource | null; id: DocId; items: AnnotationItem[] } | null = null;

/** Lista atual de anotações; cada nova leitura do `list()` troca a referência só se mudou. */
export function useAnnotations(id: DocId): AnnotationItem[] {
  return useSyncExternalStore(subscribe, () => {
    const items = source?.list(id) ?? EMPTY;
    const same =
      cache &&
      cache.src === source &&
      cache.id === id &&
      cache.items.length === items.length &&
      cache.items.every((a, i) => a.id === items[i].id && a.label === items[i].label && a.kind === items[i].kind);
    if (!same) cache = { src: source, id, items };
    return cache!.items;
  });
}
