// Imprimir e Exportar como PDF (Lote 11). As duas ações aceitam uma lista de documentos: a
// multisseleção da barra lateral (Lote 7) chama `printDocs(ids)` e `exportPdf(ids)`.
import { save as saveDialog } from "../lib/dialogs";
import { create } from "zustand";
import { notify } from "../chrome/notify";
import { current, dirname, flattenedCopy, stem } from "../file/fileActions";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo } from "../ipc/types";
import { getItems } from "../markup/store";
import { useDocs } from "../store/docs";
import { viewable } from "../viewer/actions";

/** Documentos do diálogo Imprimir aberto (`null` = fechado). */
export const usePrintUi = create<{ ids: DocId[] | null }>(() => ({ ids: null }));
export const closePrint = () => usePrintUi.setState({ ids: null });

const docOf = (id: DocId): DocInfo | null => useDocs.getState().docs.find((d) => d.id === id) ?? null;

/** Os documentos exibíveis de `ids`, na ordem dada; sem `ids`, o ativo. */
function targets(ids?: DocId[]): DocInfo[] {
  if (ids) return ids.map(docOf).filter(viewable);
  const d = current();
  return d ? [d] : [];
}

/** Abre o diálogo Imprimir com os documentos de `ids` (sem `ids`, o ativo). */
export function printDocs(ids?: DocId[]): void {
  const docs = targets(ids);
  if (docs.length) usePrintUi.setState({ ids: docs.map((d) => d.id) });
}

export const hasMarkup = (id: DocId): boolean => getItems(id).length > 0;

/**
 * Troca os documentos com anotações não achatadas por cópias achatadas: o original não muda.
 * `close` fecha as cópias e precisa ser chamado sempre.
 */
export async function flattenedIds(ids: DocId[]): Promise<{ ids: DocId[]; close: () => Promise<void> }> {
  const copies: DocId[] = [];
  const close = async () => {
    await Promise.all(copies.splice(0).map((id) => ipc.closeDocument(id).catch(() => {})));
  };
  try {
    const out: DocId[] = [];
    for (const id of ids) {
      if (!hasMarkup(id)) {
        out.push(id);
        continue;
      }
      const copy = await flattenedCopy(id, docOf(id)?.name ?? "");
      copies.push(copy.id);
      out.push(copy.id);
    }
    return { ids: out, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Nome do trabalho na fila de impressão. */
export const jobName = (ids: DocId[]): string =>
  ids.length === 1 ? (docOf(ids[0])?.name ?? "") : i18n.t("file.print.jobMany", { count: ids.length });

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isPdf = (p: string) => /\.pdf$/i.test(p);

/**
 * Pergunta o destino. Sem a extensão .pdf ela é acrescentada, e se esse outro nome já existir o
 * diálogo do sistema volta com ele, para a pergunta de substituir ser sobre o arquivo certo.
 */
async function askPdfPath(defaultPath: string): Promise<string | null> {
  const dest = await saveDialog({ defaultPath, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!dest || isPdf(dest)) return dest;
  const fixed = `${dest}.pdf`;
  return (await ipc.pathExists(fixed)) ? askPdfPath(fixed) : fixed;
}

/** Exportar como PDF…: uma página por imagem de `ids` (sem `ids`, o documento ativo). */
export async function exportPdf(ids?: DocId[]): Promise<void> {
  const docs = targets(ids);
  if (!docs.length) return;
  const first = docs[0];
  const folder = first.path ? `${dirname(first.path)}/` : "";
  const dest = await askPdfPath(`${folder}${stem(first.name)}.pdf`);
  if (!dest) return;
  const flat = await flattenedIds(docs.map((d) => d.id));
  try {
    await ipc.exportPdf(flat.ids, dest);
  } finally {
    await flat.close();
  }
  notify(i18n.t("file.print.pdfSaved", { name: basename(dest) }));
}
