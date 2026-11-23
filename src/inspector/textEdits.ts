import { useSyncExternalStore } from "react";
import { registerDirtySource } from "../file/dirty";
import type { DocId, MetadataEdits, MetaTexts } from "../ipc/types";
import { registerDocState } from "../lib/docState";

/**
 * Título, descrição, autor e texto alternativo editados no Inspetor, por documento, só em memória
 * (como as palavras-chave). O texto do arquivo é lido por página (num TIFF, cada página tem o seu);
 * a edição é do documento e, como no Rust, vale em todas as páginas que têm o campo. Contam como alteração não salva; `register.ts` os entrega ao Rust antes
 * de cada gravação (`editMetadata`) e `clearKeywords` os descarta depois de gravados ou ao reverter.
 */
export type TextField = "title" | "description" | "author" | "altText";
export const TEXT_FIELDS: readonly TextField[] = ["title", "description", "author", "altText"];

type Edits = Partial<Record<TextField, string>>;

/** Textos do arquivo, por documento e página. */
const originals = new Map<DocId, Map<number, MetaTexts>>();
const original = (id: DocId, page: number) => originals.get(id)?.get(page);
const edits = new Map<DocId, Edits>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

/** Registra os textos lidos da página `page` do arquivo (uma vez; nunca mexe na edição pendente). */
export function seedTexts(id: DocId, fromFile: MetaTexts, page = 0) {
  if (original(id, page)) return;
  originals.set(id, new Map(originals.get(id)).set(page, fromFile));
  emit();
}

/** Texto atual do campo na página `page`: o editado (vale em todas), ou o do arquivo, ou vazio. */
export function currentText(id: DocId, field: TextField, page = 0): string {
  return edits.get(id)?.[field] ?? original(id, page)?.[field] ?? "";
}

/** Os textos da página `page` do arquivo já foram lidos? */
export const hasTexts = (id: DocId, page = 0) => !!original(id, page);

/** Edita um campo (vista na página `page`); voltar ao valor do arquivo nela desfaz a pendência. */
export function setText(id: DocId, field: TextField, value: string, page = 0) {
  const next: Edits = { ...edits.get(id) };
  if (value === (original(id, page)?.[field] ?? "")) delete next[field];
  else next[field] = value;
  if (Object.keys(next).length === 0) edits.delete(id);
  else edits.set(id, next);
  emit();
}

/** Edições a gravar, ou `null` se nada foi editado. */
export function getPendingTextEdits(id: DocId): MetadataEdits | null {
  const e = edits.get(id);
  return e ? { ...e } : null;
}

export const hasPendingTextEdits = (id: DocId) => edits.has(id);

/** Descarta as edições e o que foi lido (a próxima leitura do arquivo repõe o original). */
export function clearTextEdits(id: DocId) {
  const had = edits.delete(id);
  originals.delete(id);
  if (had) emit();
}

function subscribeTexts(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

registerDirtySource((id) => edits.has(id), subscribeTexts, "texts");
// Vão junto quando o documento muda de janela.
registerDocState("texts", {
  dump: (id) => (edits.has(id) ? { edits: edits.get(id), pages: [...(originals.get(id) ?? [])] } : undefined),
  load: (id, data) => {
    const { edits: e, pages } = data as { edits: Edits; pages?: [number, MetaTexts][] };
    edits.set(id, e);
    if (pages?.length) originals.set(id, new Map(pages));
    emit();
  },
  drop: clearTextEdits,
});

export function resetTextEditsForTests() {
  edits.clear();
  originals.clear();
  emit();
}

export function useTexts(id: DocId, page = 0): Record<TextField, string> {
  useSyncExternalStore(subscribeTexts, () => version);
  return Object.fromEntries(TEXT_FIELDS.map((f) => [f, currentText(id, f, page)])) as Record<TextField, string>;
}
