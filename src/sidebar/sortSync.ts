// Mantém a ordem da barra lateral de acordo com `prefs.sortBy`: reordena ao escolher o critério e
// quando entram documentos novos ou mudam os existentes. "manual" (arraste) não toca na ordem.
import { fileStats } from "../ipc/commands";
import type { DocId, FileStat } from "../ipc/types";
import { useDocs } from "../store/docs";
import { getPrefs, subscribePrefs } from "../store/prefs";
import { needsStats, sortedIds } from "./sort";

export function startSortSync(): () => void {
  /** Estatística de disco por documento, válida enquanto a revisão for a mesma. */
  const stats = new Map<DocId, { rev: number; stat: FileStat }>();
  let seq = 0;

  const run = async () => {
    const by = getPrefs().sortBy;
    if (by === "manual") return;
    const mine = ++seq;
    if (needsStats(by)) {
      const missing = useDocs.getState().docs.filter((d) => d.path && stats.get(d.id)?.rev !== d.rev);
      if (missing.length) {
        const revs = new Map(missing.map((d) => [d.id, d.rev]));
        try {
          for (const stat of await fileStats(missing.map((d) => d.id))) stats.set(stat.id, { rev: revs.get(stat.id) ?? 0, stat });
        } catch (e) {
          console.error("falha ao ler os dados dos arquivos:", e);
        }
        if (mine !== seq) return;
      }
    }
    const docs = useDocs.getState().docs;
    const known = new Map([...stats].map(([id, v]) => [id, v.stat]));
    useDocs.getState().applyOrder(sortedIds(docs, by, known));
  };

  let last = useDocs.getState().docs;
  const offDocs = useDocs.subscribe((s) => {
    if (s.docs === last) return;
    last = s.docs;
    void run();
  });
  const offPrefs = subscribePrefs(() => void run());
  void run();
  return () => {
    seq++;
    offDocs();
    offPrefs();
  };
}
