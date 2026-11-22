// Ações do Lote 5 (Finder no Linux): Salvar Como, Mover para o Lixo, etiquetas, bloquear e versões.
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { notify } from "../chrome/notify";
import { defaultOptions, EXTENSIONS, exportFormatOf } from "../file/estimate";
import { runBeforeSave } from "../file/beforeSave";
import { hasUnsaved } from "../file/dirty";
import { confirmLosses } from "../file/loss";
import { current, dirname, markChanged, settleKeywords, stem, warnLeftOut } from "../file/fileActions";
import i18n from "../i18n";
import { clearKeywords, getPendingKeywords } from "../inspector/keywords";
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo, ExportFormat } from "../ipc/types";
import { forgetHistory } from "../markup/history";
import { hasPages, shownPage } from "../markup/pages";
import { useMarkup } from "../markup/store";
import { useDocs } from "../store/docs";
import { addRecent } from "../store/prefs";
import { activeDoc } from "../viewer/actions";
import { askDiscard, closePopover, setLockedState } from "./store";

export { addTags, splitTags } from "./tags";

const t = (k: string, o: Record<string, unknown> = {}) => i18n.t(k, o);
const update = (info: DocInfo) => useDocs.getState().update(info);

/** Formatos que o Salvar regrava (os únicos do Salvar Como), pela extensão. */
const SAVE_AS_EXT: Record<string, ExportFormat> = {
  jpg: "jpeg", jpeg: "jpeg", png: "png", tif: "tiff", tiff: "tiff", webp: "webp", avif: "avif", bmp: "bmp",
};

export function saveAsFormat(path: string): ExportFormat | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (SAVE_AS_EXT[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** Documento ativo ligado a um arquivo (mesmo com erro de decodificação), ou `null`. */
export function activeFile(): DocInfo | null {
  const d = activeDoc();
  return d?.path ? d : null;
}

/** Salvar Como… (Ctrl+Shift+Alt+S): grava num arquivo novo, que passa a ser o documento. */
export async function saveAsActive(): Promise<void> {
  const d = current();
  if (!d) return;
  // A página de quando se pediu: ela pode mudar com o diálogo aberto.
  const frame = shownPage(d.id);
  const guess = SAVE_AS_EXT[EXTENSIONS[exportFormatOf(d.format)]] ?? "png";
  const dir = d.path ? `${dirname(d.path)}/` : "";
  const dest = await saveDialog({
    defaultPath: `${dir}${stem(d.name)}.${EXTENSIONS[guess]}`,
    filters: [{ name: t("finder.saveAs.images"), extensions: Object.keys(SAVE_AS_EXT) }],
  });
  if (!dest) return;
  const format = saveAsFormat(dest);
  if (!format) return notify(t("finder.saveAs.badFormat"));
  const allPages = format === "tiff" && hasPages(d);
  const opts = { ...defaultOptions(format), frame, ...(allPages ? { allPages } : {}) };
  if (!(await confirmLosses(d, opts))) return;
  const page = allPages ? null : frame;
  await runBeforeSave(d.id, page);
  const info = await ipc.saveAs(d.id, dest, opts, getPendingKeywords(d.id));
  update(info);
  addRecent(info.path);
  markChanged(d.id, null);
  settleKeywords(d.id, format);
  notify(t("file.saved", { name: info.name }));
  warnLeftOut(info, page, dest);
}

/** Mover para o Lixo (Ctrl+Backspace). Com alterações, pergunta antes. Nunca apaga. */
export async function moveActiveToTrash(): Promise<void> {
  const d = activeFile();
  if (!d) return;
  if (hasUnsaved(d) && !(await askDiscard(d.id, d.name, "finder.trash.confirmUnsaved", "finder.trash.ok"))) return;
  await ipc.moveToTrash(d.id);
  closePopover();
  await useDocs.getState().close(d.id);
  notify(t("finder.trash.done", { name: d.name }));
}

/** Lê do disco se o arquivo está bloqueado (e guarda no estado da interface). */
export async function refreshLocked(id: DocId): Promise<boolean> {
  const locked = await ipc.fileLocked(id);
  setLockedState(id, locked);
  return locked;
}

/** Bloquear/Desbloquear o arquivo do documento. */
export async function setLocked(id: DocId, locked: boolean): Promise<void> {
  const info = await ipc.setLocked(id, locked);
  update(info);
  setLockedState(id, locked);
  notify(t(locked ? "finder.lock.locked" : "finder.lock.unlocked", { name: info.name }));
}

export async function toggleLockActive(): Promise<void> {
  const d = activeFile();
  if (d) await setLocked(d.id, !(await refreshLocked(d.id)));
}

/**
 * Restaurar uma versão: vira o conteúdo do documento, que fica com alterações (o Salvar grava).
 * Com alterações não salvas, pergunta antes. `false` se o usuário cancelou.
 */
export async function restoreVersion(id: DocId, version: string): Promise<boolean> {
  const d = useDocs.getState().docs.find((x) => x.id === id);
  if (!d) return false;
  if (hasUnsaved(d) && !(await askDiscard(id, d.name, "finder.versions.confirmUnsaved", "finder.versions.restore"))) {
    return false;
  }
  update(await ipc.restoreVersion(id, version));
  // Como no Reverter: anotações e desfazer do JS não valem para o conteúdo novo.
  useMarkup.getState().drop(id);
  forgetHistory(id);
  clearKeywords(id);
  markChanged(id, null);
  notify(t("finder.versions.restored"));
  return true;
}
