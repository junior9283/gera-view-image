// Ganchos que rodam antes de gravar (Salvar, Exportar e Exportar Selecionadas). Imprimir e Duplicar
// não passam por aqui: usam uma cópia achatada (`flattenedCopy`) e deixam o original como está.
// A Marcação (Task 8) registra aqui o achatamento das anotações (`flattenAnnotations`).
import type { DocId } from "../ipc/types";

/** `page`: a página que vai ser gravada; `null` = todas (TIFF de várias páginas). */
type Hook = (id: DocId, page: number | null) => Promise<void>;

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
export async function runBeforeSave(id: DocId, page: number | null = 0): Promise<void> {
  for (const fn of [...hooks]) await fn(id, page);
}
