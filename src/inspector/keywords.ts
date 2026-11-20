import { useSyncExternalStore } from "react";
import type { DocId } from "../ipc/types";

/**
 * Palavras-chave editadas no inspetor, por documento, só em memória.
 * A gravação em IPTC `Keywords` / XMP `dc:subject` é da Task 11 (salvar), que lê `getPendingKeywords`.
 * `null` = o usuário não editou: o arquivo permanece como está.
 */
const lists = new Map<DocId, string[]>();
const originals = new Map<DocId, string[]>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

/** Registra a lista lida do arquivo (não sobrescreve edição já feita). */
export function seedKeywords(id: DocId, fromFile: string[]) {
  if (originals.has(id)) return;
  originals.set(id, fromFile);
  emit();
}

/** Lista atual: a editada, ou a do arquivo se não houve edição. */
export function currentKeywords(id: DocId): string[] {
  return lists.get(id) ?? originals.get(id) ?? [];
}

/** Lista a gravar ao salvar, ou `null` se não foi editada. */
export function getPendingKeywords(id: DocId): string[] | null {
  return lists.get(id) ?? null;
}

export function addKeyword(id: DocId, raw: string) {
  const word = raw.trim();
  if (!word) return;
  const cur = currentKeywords(id);
  if (cur.includes(word)) return;
  lists.set(id, [...cur, word]);
  emit();
}

export function removeKeyword(id: DocId, word: string) {
  lists.set(id, currentKeywords(id).filter((k) => k !== word));
  emit();
}

/** Descarta a edição (ex.: depois que a Task 11 gravou o arquivo). */
export function clearKeywords(id: DocId) {
  const had = lists.delete(id);
  originals.delete(id);
  if (had) emit();
}

export function resetKeywordsForTests() {
  lists.clear();
  originals.clear();
  emit();
}

export function useKeywords(id: DocId): string[] {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  return currentKeywords(id);
}
