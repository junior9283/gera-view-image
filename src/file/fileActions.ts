// Ações do menu Arquivo (e Colar). Registradas como comandos em `register.ts`.
import { open as openDialog } from "../lib/dialogs";
import { create } from "zustand";
import { notify } from "../chrome/notify";
import i18n from "../i18n";
import { clearKeywords, getPendingKeywords } from "../inspector/keywords";
import { reportMetaNotes } from "../inspector/notes";
import { hasPendingTextEdits } from "../inspector/textEdits";
import * as ipc from "../ipc/commands";
import { annotationLayers } from "../markup/flatten";
import { forgetHistory } from "../markup/history";
import { hasPages, leavesOut } from "../markup/pages";
import { getItems, useMarkup } from "../markup/store";
import type { CaptureMode, DocId, DocInfo, ExportOptions, RevertTarget } from "../ipc/types";
import { useDocs } from "../store/docs";
import { activate, activeDoc, viewable } from "../viewer/actions";
import { runBeforeSave } from "./beforeSave";
import { exportFormatOf } from "./estimate";
import { confirmLosses, TEXT_FORMATS } from "./loss";
import { confirmClose } from "./unsaved";

export type FileDialog =
  | { kind: "export"; id: DocId; mode: "export" | "save" }
  | { kind: "exportSelected" }
  | { kind: "rename"; id: DocId };

interface FileUi {
  dialog: FileDialog | null;
  /** Documentos cujo arquivo mudou (`false`) ou sumiu (`true`) fora do app. */
  changed: Record<DocId, boolean>;
}

export const useFileUi = create<FileUi>(() => ({ dialog: null, changed: {} }));

export const openFileDialog = (dialog: FileDialog) => useFileUi.setState({ dialog });
export const closeFileDialog = () => useFileUi.setState({ dialog: null });

export function markChanged(id: DocId, removed: boolean | null): void {
  const changed = { ...useFileUi.getState().changed };
  if (removed === null) delete changed[id];
  else changed[id] = removed;
  useFileUi.setState({ changed });
}

const t = (k: string, o: Record<string, unknown> = {}) => i18n.t(k, o);
const update = (info: DocInfo) => useDocs.getState().update(info);

/** Documento ativo exibível (sem erro), ou `null`. */
export function current(): DocInfo | null {
  const d = activeDoc();
  return viewable(d) ? d : null;
}

export const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const stem = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/**
 * Salvar: grava no próprio arquivo. Formatos que não dá para regravar (RAW, PSD, GIF, sem
 * caminho...) abrem Exportar. `true` se gravou.
 */
export async function saveDoc(d: DocInfo): Promise<boolean> {
  const toExport = () => {
    openFileDialog({ kind: "export", id: d.id, mode: "save" });
    return false;
  };
  // Antes de achatar: cancelar o Exportar não pode deixar nada mudado.
  if (!d.writable || (await ipc.saveNeedsExport(d.id))) return toExport();
  // Um TIFF de várias páginas é gravado inteiro.
  const allPages = hasPages(d);
  if (!(await confirmLosses(d, { format: exportFormatOf(d.format), stripMetadata: false, allPages }))) return false;
  await runBeforeSave(d.id, allPages ? null : 0);
  const out = await ipc.save(d.id, getPendingKeywords(d.id));
  if (out.type === "needsExport") return toExport();
  update(out.data);
  settleKeywords(d.id, out.data.format);
  markChanged(d.id, null);
  notify(t("file.saved", { name: out.data.name }));
  return true;
}

/**
 * Só a página `page` (nulo = todas) de `info` foi para `dest`: avisa se ficaram de fora anotações de outra, por
 * achatar ou já achatadas (aí o documento, que passou a ser `dest`, continua com alterações).
 */
export function warnLeftOut(info: DocInfo, page: number | null, dest: string): void {
  if (page === null) return;
  if (leavesOut(info.id, page) || (hasPages(info) && info.path === dest && info.dirty)) notify(t("file.otherPages", { page: page + 1 }));
}

/**
 * Exporta a página `opts.frame` de um documento, ou todas (achata antes as anotações dela), com etiquetas.
 * Devolve o `DocInfo` atualizado.
 */
export async function exportDoc(id: DocId, dest: string, opts: ExportOptions, tags: string[] = []): Promise<DocInfo> {
  const page = opts.allPages ? null : (opts.frame ?? 0);
  await runBeforeSave(id, page);
  const keywords = getPendingKeywords(id);
  let info: DocInfo;
  if (tags.length) {
    const out = await ipc.exportTagged(id, dest, opts, keywords, tags);
    info = out.info;
    if (out.tagsError) notify(t("file.export.tagsNotSaved"));
  } else {
    info = await ipc.exportDoc(id, dest, opts, keywords);
  }
  update(info);
  if (info.path === dest) settleKeywords(id, opts.stripMetadata ? null : opts.format);
  else void reportMetaNotes(id);
  warnLeftOut(info, page, dest);
  return info;
}

/**
 * Depois de gravar no próprio arquivo: palavras-chave pendentes saem da fila só se o formato as
 * grava; senão continuam pendentes e o usuário é avisado (`format` nulo = metadados removidos).
 */
export function settleKeywords(id: DocId, format: string | null): void {
  void reportMetaNotes(id);
  if (!getPendingKeywords(id) && !hasPendingTextEdits(id)) return;
  if (format && TEXT_FORMATS.has(format)) clearKeywords(id);
  else notify(t("file.keywordsNotSaved"));
}

async function revertDoc(id: DocId, to: RevertTarget): Promise<void> {
  update(await ipc.revert(id, to));
  // Volta ao arquivo: as anotações não achatadas e a pilha de desfazer do JS não valem mais.
  useMarkup.getState().drop(id);
  forgetHistory(id);
  clearKeywords(id);
  markChanged(id, null);
}

export async function revert(to: RevertTarget): Promise<void> {
  const d = current();
  if (d) await revertDoc(d.id, to);
}

/** Recarregar (faixa de alteração externa): relê o arquivo; com alterações não salvas, pergunta antes. */
export async function reload(id: DocId): Promise<void> {
  const d = useDocs.getState().docs.find((x) => x.id === id);
  if (d && (await confirmClose([d], "reload")) !== "discard") return;
  await revertDoc(id, "lastSaved");
}

export async function ignoreChange(id: DocId): Promise<void> {
  markChanged(id, null);
  await ipc.ignoreDiskChange(id);
}

export async function renameDoc(id: DocId, name: string): Promise<void> {
  update(await ipc.renameDoc(id, name));
}

export async function moveActive(): Promise<void> {
  const d = current();
  if (!d?.path) return;
  const dir = await openDialog({ directory: true, multiple: false, defaultPath: dirname(d.path) });
  if (typeof dir !== "string") return;
  update(await ipc.moveTo(d.id, dir));
}

async function addAndShow(info: DocInfo | null): Promise<void> {
  if (!info) return;
  useDocs.getState().add([info]);
  activate(info.id);
}

/**
 * Cópia em memória de `id` com as anotações não salvas achatadas nela. O original não muda: as
 * anotações continuam editáveis e o estado de "sujo" fica igual. Se o achatamento falhar, a cópia é fechada.
 */
export async function flattenedCopy(id: DocId, name: string): Promise<DocInfo> {
  const layers = await annotationLayers(id);
  let copy = await ipc.duplicate(id, name);
  try {
    for (const { op } of layers) copy = await ipc.applyOp(copy.id, op);
    return copy;
  } catch (e) {
    await ipc.closeDocument(copy.id).catch(() => {});
    throw e;
  }
}

export async function duplicateActive(): Promise<void> {
  const d = current();
  if (!d) return;
  const name = t("file.copyName", { name: stem(d.name) });
  if (!hasPages(d)) return addAndShow(await flattenedCopy(d.id, name));
  // Várias páginas: o Exportar grava uma só, então as anotações seguem editáveis na cópia.
  const copy = await ipc.duplicate(d.id, name);
  useMarkup.getState().setItems(copy.id, getItems(d.id));
  await addAndShow(copy);
}

export const newFromClipboard = async () => addAndShow(await ipc.newFromClipboard(t("file.untitled")));

export const capture = (mode: CaptureMode) => async () => addAndShow(await ipc.captureScreen(mode, t("file.capture")));

export const showInFolder = async () => {
  const d = current();
  if (d?.path) await ipc.reveal(d.id);
};

export const openWith = async () => {
  const d = current();
  if (d?.path) await ipc.openWith(d.id);
};
