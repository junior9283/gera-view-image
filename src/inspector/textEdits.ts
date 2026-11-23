import { useSyncExternalStore } from "react";
import { registerDirtySource } from "../file/dirty";
import type { DocId, MetadataEdits, MetaTexts } from "../ipc/types";
import { registerDocState } from "../lib/docState";

/**
 * Título, descrição, autor e texto alternativo editados no Inspetor, por documento, só em memória
 * (como as palavras-chave). Contam como alteração não salva; `register.ts` os entrega ao Rust antes
 * de cada gravação (`editMetadata`) e `clearKeywords` os descarta depois de gravados ou ao reverter.
 */
export type TextField = "title" | "description" | "author" | "altText";
export const TEXT_FIELDS: readonly TextField[] = ["title", "description", "author", "altText"];

type Edits = Partial<Record<TextField, string>>;

const originals = new Map<DocId, MetaTexts>();
const edits = new Map<DocId, Edits>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}

/** Registra os textos lidos do arquivo (não sobrescreve edição já feita). */
export function seedTexts(id: DocId, fromFile: MetaTexts) {
  if (originals.has(id)) return;
  originals.set(id, fromFile);
  emit();
}

/** Texto atual do campo: o editado, ou o do arquivo, ou vazio. */
export function currentText(id: DocId, field: TextField): string {
  return edits.get(id)?.[field] ?? originals.get(id)?.[field] ?? "";
}

/** Os textos do arquivo já foram lidos? */
export const hasTexts = (id: DocId) => originals.has(id);

/** Edita um campo; voltar ao valor do arquivo desfaz a pendência. */
export function setText(id: DocId, field: TextField, value: string) {
  const next: Edits = { ...edits.get(id) };
  if (value === (originals.get(id)?.[field] ?? "")) delete next[field];
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
  dump: (id) => (edits.has(id) ? { edits: edits.get(id), original: originals.get(id) } : undefined),
  load: (id, data) => {
    const { edits: e, original } = data as { edits: Edits; original?: MetaTexts };
    edits.set(id, e);
    if (original) originals.set(id, original);
    emit();
  },
  drop: clearTextEdits,
});

export function resetTextEditsForTests() {
  edits.clear();
  originals.clear();
  emit();
}

export function useTexts(id: DocId): Record<TextField, string> {
  useSyncExternalStore(subscribeTexts, () => version);
  return {
    title: currentText(id, "title"),
    description: currentText(id, "description"),
    author: currentText(id, "author"),
    altText: currentText(id, "altText"),
  };
}
