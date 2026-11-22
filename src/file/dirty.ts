// "Sujeira" além das `Op` do Rust (`DocInfo.dirty`): anotações não achatadas (Task 8),
// palavras-chave editadas (Task 10)... Quem guarda estado não salvo registra aqui; o diálogo de
// não salvo, o Salvar e os menus consultam `hasUnsaved`.
import type { DocId, DocInfo } from "../ipc/types";
import { isCarried } from "../lib/docState";

type IsDirty = (id: DocId) => boolean;
type Subscribe = (l: () => void) => () => void;

interface Source {
  isDirty: IsDirty;
  carriedBy?: string;
}

const sources = new Set<Source>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Registra uma fonte (e, se houver, como saber que ela mudou); devolve a função que a remove.
 * `carriedBy` é a chave de `registerDocState` que leva esse estado para outra janela: sem ela, um
 * documento com essa alteração não muda de janela.
 */
export function registerDirtySource(isDirty: IsDirty, subscribe?: Subscribe, carriedBy?: string): () => void {
  const source = { isDirty, carriedBy };
  sources.add(source);
  const off = subscribe?.(emit);
  emit();
  return () => {
    sources.delete(source);
    off?.();
    emit();
  };
}

/** Avisa quando alguma fonte muda (para menus reavaliarem o Salvar). */
export function subscribeDirty(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Há algo a salvar: `Op` no Rust ou estado registrado por outra parte do app. */
export const hasUnsaved = (d: DocInfo): boolean => d.dirty || [...sources].some((s) => s.isDirty(d.id));

/** Tem alteração que não há como levar para outra janela. */
export const hasUncarried = (id: DocId): boolean =>
  [...sources].some((s) => s.isDirty(id) && !(s.carriedBy && isCarried(s.carriedBy)));
