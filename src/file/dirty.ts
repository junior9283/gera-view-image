// "Sujeira" além das `Op` do Rust (`DocInfo.dirty`): anotações não achatadas (Task 8),
// palavras-chave editadas (Task 10)... Quem guarda estado não salvo registra aqui; o diálogo de
// não salvo, o Salvar e os menus consultam `hasUnsaved`.
import type { DocId, DocInfo } from "../ipc/types";

type IsDirty = (id: DocId) => boolean;
type Subscribe = (l: () => void) => () => void;

const sources = new Set<IsDirty>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Registra uma fonte (e, se houver, como saber que ela mudou); devolve a função que a remove. */
export function registerDirtySource(isDirty: IsDirty, subscribe?: Subscribe): () => void {
  sources.add(isDirty);
  const off = subscribe?.(emit);
  emit();
  return () => {
    sources.delete(isDirty);
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
export const hasUnsaved = (d: DocInfo): boolean => d.dirty || [...sources].some((f) => f(d.id));
