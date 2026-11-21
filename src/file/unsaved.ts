import type { DocInfo } from "../ipc/types";
import { hasUnsaved } from "./dirty";

export type CloseChoice = "save" | "discard" | "cancel";

/** `close`: fechar/navegar (Salvar, Não Salvar, Cancelar). `reload`: recarregar do disco (Recarregar, Cancelar). */
export type UnsavedPurpose = "close" | "reload";

interface Request {
  docs: DocInfo[];
  purpose: UnsavedPurpose;
  resolve: (c: CloseChoice) => void;
}

/** Pedidos em fila (um diálogo por vez, mostrado pelo `UnsavedDialog`). */
let queue: Request[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Pergunta o que fazer antes de fechar documentos com alterações (fechar documento, navegar
 * pela pasta, fechar a janela) ou de recarregá-los do disco (`purpose = "reload"`, sem Salvar).
 * Sem nenhum sujo, resolve `'discard'` sem diálogo.
 */
export function confirmClose(docs: DocInfo[], purpose: UnsavedPurpose = "close"): Promise<CloseChoice> {
  const dirty = docs.filter(hasUnsaved);
  if (!dirty.length) return Promise.resolve("discard");
  return new Promise((resolve) => {
    queue = [...queue, { docs: dirty, purpose, resolve }];
    emit();
  });
}

export function subscribeUnsaved(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Pedido em exibição (o primeiro da fila). */
export const currentUnsaved = (): { docs: DocInfo[]; purpose: UnsavedPurpose } | null => queue[0] ?? null;

/** Resposta do diálogo ao pedido em exibição. */
export function answerUnsaved(c: CloseChoice): void {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  emit();
  first.resolve(c);
}

type SaveHandler = (d: DocInfo) => Promise<boolean>;
let saveHandler: SaveHandler = async () => false;

/** Quem salva quando o usuário escolhe "Salvar" (registrado por `file/register.ts`). */
export function setSaveHandler(fn: SaveHandler): void {
  saveHandler = fn;
}

/**
 * `confirmClose` + salvar: `true` se pode fechar (descartou, ou todos os sujos foram salvos).
 * Um que precisa de Exportar (ou falha) mantém tudo aberto.
 */
export async function confirmAndSave(docs: DocInfo[]): Promise<boolean> {
  const choice = await confirmClose(docs);
  if (choice !== "save") return choice === "discard";
  for (const d of docs.filter(hasUnsaved)) {
    if (!(await saveHandler(d))) return false;
  }
  return true;
}

/** Só para testes. */
export function resetUnsavedForTests(): void {
  queue = [];
  saveHandler = async () => false;
  emit();
}
