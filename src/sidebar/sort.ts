// Ordenar Por (Nome, Data, Tipo, Tamanho): calcula a ordem da barra lateral.
import type { DocId, DocInfo, FileStat } from "../ipc/types";
import type { Prefs } from "../store/prefs";

export type SortBy = Prefs["sortBy"];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Data e tamanho vêm do disco (`file_stats`); nome e tipo saem do próprio DocInfo. */
export const needsStats = (by: SortBy): boolean => by === "date" || by === "size";

/**
 * Ids na ordem pedida. Nome e Tipo crescem; Data (mais recente primeiro) e Tamanho (maior primeiro)
 * decrescem, como o Pré-Visualização. Sem dado (arquivo inexistente), o item vai ao fim; empates
 * se resolvem pelo nome e, depois, pela ordem atual.
 */
export function sortedIds(docs: DocInfo[], by: SortBy, stats: ReadonlyMap<DocId, FileStat>): DocId[] {
  if (by === "manual") return docs.map((d) => d.id);
  const num = (d: DocInfo): number | null => {
    const s = stats.get(d.id);
    return (by === "date" ? s?.modifiedMs : s?.size) ?? null;
  };
  const byName = (a: DocInfo, b: DocInfo) => collator.compare(a.name, b.name);
  const cmp = (a: DocInfo, b: DocInfo): number => {
    if (by === "name") return byName(a, b);
    if (by === "kind") return collator.compare(a.format, b.format) || byName(a, b);
    const x = num(a);
    const y = num(b);
    if (x === y) return byName(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  return [...docs].sort(cmp).map((d) => d.id);
}
