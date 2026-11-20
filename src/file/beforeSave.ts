// Ganchos que rodam antes de gravar (Salvar, Exportar, Exportar Selecionadas e Imprimir).
// A Marcação (Task 8) registra aqui o achatamento das anotações (`flattenAnnotations`).
import type { DocId } from "../ipc/types";

type Hook = (id: DocId) => Promise<void>;

const hooks: Hook[] = [];

/** Registra um gancho; devolve a função que o remove. */
export function registerBeforeSave(fn: Hook): () => void {
  hooks.push(fn);
  return () => {
    const i = hooks.indexOf(fn);
    if (i >= 0) hooks.splice(i, 1);
  };
}

/** Roda os ganchos em ordem; um erro interrompe a gravação. */
export async function runBeforeSave(id: DocId): Promise<void> {
  for (const fn of [...hooks]) await fn(id);
}
