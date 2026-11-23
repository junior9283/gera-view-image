import { useSyncExternalStore } from "react";
import { registerDirtySource } from "../file/dirty";
import type { DocId } from "../ipc/types";
import { registerDocState } from "../lib/docState";
import { clearTextEdits } from "./textEdits";

/**
 * Palavras-chave editadas no inspetor, por documento, só em memória. A lista do arquivo é lida por
 * página; a editada é do documento e, como no Rust, vale em todas as páginas que têm palavras-chave.
 * A gravação em IPTC `Keywords` / XMP `dc:subject` é da Task 11 (salvar), que lê `getPendingKeywords`.
 * `null` = o usuário não editou: o arquivo permanece como está.
 */
const lists = new Map<DocId, string[]>();
/** Lista do arquivo, por documento e página. */
const originals = new Map<DocId, Map<number, string[]>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

/** Registra a lista lida da página `page` do arquivo (uma vez; nunca mexe na edição pendente). */
export function seedKeywords(id: DocId, fromFile: string[], page = 0) {
  if (originals.get(id)?.has(page)) return;
  originals.set(id, new Map(originals.get(id)).set(page, fromFile));
  emit();
}

/** Lista atual na página `page`: a editada (vale em todas), ou a do arquivo se não houve edição. */
export function currentKeywords(id: DocId, page = 0): string[] {
  return lists.get(id) ?? originals.get(id)?.get(page) ?? [];
}

/** Lista a gravar ao salvar, ou `null` se não foi editada. */
export function getPendingKeywords(id: DocId): string[] | null {
  return lists.get(id) ?? null;
}

export function addKeyword(id: DocId, raw: string, page = 0) {
  const word = raw.trim();
  if (!word) return;
  const cur = currentKeywords(id, page);
  if (cur.includes(word)) return;
  lists.set(id, [...cur, word]);
  emit();
}

export function removeKeyword(id: DocId, word: string, page = 0) {
  lists.set(id, currentKeywords(id, page).filter((k) => k !== word));
  emit();
}

/** Descarta a edição (ex.: depois que a Task 11 gravou o arquivo). */
export function clearKeywords(id: DocId) {
  clearTextEdits(id); // título, descrição, autor e texto alternativo seguem o mesmo ciclo
  const had = lists.delete(id);
  originals.delete(id);
  if (had) emit();
}

function subscribeKeywords(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Palavras-chave editadas e ainda não gravadas contam como alteração (Salvar, diálogo de não salvo).
registerDirtySource((id) => lists.has(id), subscribeKeywords, "keywords");
// E vão junto quando o documento muda de janela.
registerDocState("keywords", {
  dump: (id) => (lists.has(id) ? { list: lists.get(id), pages: [...(originals.get(id) ?? [])] } : undefined),
  load: (id, data) => {
    const { list, pages } = data as { list: string[]; pages?: [number, string[]][] };
    lists.set(id, list);
    if (pages?.length) originals.set(id, new Map(pages));
    emit();
  },
  drop: clearKeywords,
});

export function resetKeywordsForTests() {
  lists.clear();
  originals.clear();
  emit();
}

export function useKeywords(id: DocId, page = 0): string[] {
  useSyncExternalStore(subscribeKeywords, () => version);
  return currentKeywords(id, page);
}
