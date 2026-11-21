// Ações do menu Arquivo (e Colar). Registradas como comandos em `register.ts`.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { notify } from "../chrome/notify";
import i18n from "../i18n";
import { clearKeywords, getPendingKeywords } from "../inspector/keywords";
import * as ipc from "../ipc/commands";
import { annotationsPng } from "../markup/flatten";
import { forgetHistory } from "../markup/history";
import { getItems, useMarkup } from "../markup/store";
import type { CaptureMode, DocId, DocInfo, ExportOptions, RevertTarget } from "../ipc/types";
import { useDocs } from "../store/docs";
import { addRecent, getPrefs, setPrefs } from "../store/prefs";
import { activate, activeDoc, viewable } from "../viewer/actions";
import { runBeforeSave } from "./beforeSave";
import { confirmClose } from "./unsaved";

export type FileDialog =
  | { kind: "export"; id: DocId; mode: "export" | "save" }
  | { kind: "exportSelected" }
  | { kind: "rename"; id: DocId }
  | { kind: "recent" };

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
export const stem = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/**
 * Salvar: grava no próprio arquivo. Formatos que não dá para regravar (RAW, PSD, GIF, sem
 * caminho...) abrem Exportar. `true` se gravou.
 */
export async function saveDoc(d: DocInfo): Promise<boolean> {
  await runBeforeSave(d.id);
  const out = await ipc.save(d.id, getPendingKeywords(d.id));
  if (out.type === "needsExport") {
    openFileDialog({ kind: "export", id: d.id, mode: "save" });
    return false;
  }
  update(out.data);
  settleKeywords(d.id, out.data.format);
  markChanged(d.id, null);
  notify(t("file.saved", { name: out.data.name }));
  return true;
}

/** Exporta um documento (achata anotações antes). Devolve o `DocInfo` atualizado. */
export async function exportDoc(id: DocId, dest: string, opts: ExportOptions): Promise<DocInfo> {
  await runBeforeSave(id);
  const info = await ipc.exportDoc(id, dest, opts, getPendingKeywords(id));
  update(info);
  if (info.path === dest) settleKeywords(id, opts.stripMetadata ? null : opts.format);
  return info;
}

/**
 * Formatos em que o Salvar/Exportar grava as palavras-chave: IPTC 2:25 (JPEG, TIFF) e/ou XMP
 * `dc:subject` (JPEG, TIFF, PNG, WebP). AVIF (o codificador só grava EXIF), BMP e OpenEXR as perdem.
 */
const KEYWORD_FORMATS: ReadonlySet<string> = new Set(["jpeg", "tiff", "png", "webp"]);

/**
 * Depois de gravar no próprio arquivo: palavras-chave pendentes saem da fila só se o formato as
 * grava; senão continuam pendentes e o usuário é avisado (`format` nulo = metadados removidos).
 */
export function settleKeywords(id: DocId, format: string | null): void {
  if (!getPendingKeywords(id)) return;
  if (format && KEYWORD_FORMATS.has(format)) clearKeywords(id);
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

/** Arquivo do documento mudou de caminho (renomear/mover). */
function relocated(info: DocInfo): void {
  update(info);
  addRecent(info.path);
}

export async function renameDoc(id: DocId, name: string): Promise<void> {
  relocated(await ipc.renameDoc(id, name));
}

export async function moveActive(): Promise<void> {
  const d = current();
  if (!d?.path) return;
  const dir = await openDialog({ directory: true, multiple: false, defaultPath: dirname(d.path) });
  if (typeof dir !== "string") return;
  relocated(await ipc.moveTo(d.id, dir));
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
async function flattenedCopy(id: DocId, name: string): Promise<DocInfo> {
  const png = await annotationsPng(id);
  const copy = await ipc.duplicate(id, name);
  if (!png) return copy;
  try {
    return await ipc.applyOp(copy.id, { type: "composite", data: { png } });
  } catch (e) {
    await ipc.closeDocument(copy.id).catch(() => {});
    throw e;
  }
}

export async function duplicateActive(): Promise<void> {
  const d = current();
  if (!d) return;
  await addAndShow(await flattenedCopy(d.id, t("file.copyName", { name: stem(d.name) })));
}

export const newFromClipboard = async () => addAndShow(await ipc.newFromClipboard(t("file.untitled")));

export const capture = (mode: CaptureMode) => async () => addAndShow(await ipc.captureScreen(mode, t("file.capture")));

export async function printActive(): Promise<void> {
  const d = current();
  if (!d) return;
  const title = t("file.print.title");
  if (!getItems(d.id).length) return ipc.printDocument(d.id, title);
  // Imprime uma cópia temporária achatada (o `print_document` renderiza o PNG antes de voltar).
  const copy = await flattenedCopy(d.id, d.name);
  try {
    await ipc.printDocument(copy.id, title);
  } finally {
    await ipc.closeDocument(copy.id).catch(() => {});
  }
}

export const showInFolder = async () => {
  const d = current();
  if (d?.path) await ipc.reveal(d.id);
};

export const openWith = async () => {
  const d = current();
  if (d?.path) await ipc.openWith(d.id);
};

/** Abre um recente; se ele não abrir (apagado/movido), sai da lista. */
export async function openRecent(path: string): Promise<void> {
  const [info] = await useDocs.getState().open([path]);
  if (!info) return;
  activate(info.id);
  if (info.error) setPrefs({ recent: getPrefs().recent.filter((p) => p !== path) });
}
