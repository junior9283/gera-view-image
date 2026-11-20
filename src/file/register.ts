// Liga o menu Arquivo (e Colar) ao registro de comandos, a faixa de alteração externa ao slot
// `below-toolbar`, o fechar da janela ao diálogo de não salvo e os abertos aos Recentes.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { subscribe } from "../lib/events";
import { registerSlot } from "../lib/slots";
import { DOC_CHANGED_ON_DISK_EVENT, type DiskChanged } from "../ipc/types";
import { registerCommand, type CommandId } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { addRecent, getPrefs } from "../store/prefs";
import * as file from "./fileActions";
import { DiskBanner } from "./DiskBanner";
import { confirmAndSave, setSaveHandler } from "./unsaved";

const hasDoc = () => !!file.current();
const hasFile = () => !!file.current()?.path;
const exportable = () => useDocs.getState().docs.some((d) => !d.error && d.width > 0);
const withDoc = (f: (id: number) => unknown) => () => {
  const d = file.current();
  return d && f(d.id);
};

type Entry = [CommandId, () => unknown, (() => boolean)?];

const ENTRIES: Entry[] = [
  ["file.newFromClipboard", file.newFromClipboard],
  ["edit.paste", file.newFromClipboard],
  ["file.openRecent", () => file.openFileDialog({ kind: "recent" }), () => getPrefs().recent.length > 0],
  ["file.save", () => {
    const d = file.current();
    return d && file.saveDoc(d);
  }, () => {
    const d = file.current();
    return !!d && (d.dirty || !d.writable);
  }],
  ["file.duplicate", file.duplicateActive, hasDoc],
  ["file.rename", withDoc((id) => file.openFileDialog({ kind: "rename", id })), hasFile],
  ["file.moveTo", file.moveActive, hasFile],
  ["file.showInFolder", file.showInFolder, hasFile],
  ["file.openWith", file.openWith, hasFile],
  ["file.revertLastSaved", () => file.revert("lastSaved"), () => hasFile() && !!file.current()?.dirty],
  ["file.revertOriginal", () => file.revert("original"), () => hasFile() && !!(file.current()?.canUndo || file.current()?.dirty)],
  ["file.export", withDoc((id) => file.openFileDialog({ kind: "export", id, mode: "export" })), hasDoc],
  ["file.exportSelected", () => file.openFileDialog({ kind: "exportSelected" }), exportable],
  ["file.captureSelection", file.capture("selection")],
  ["file.captureWindow", file.capture("window")],
  ["file.captureScreen", file.capture("screen")],
  ["file.print", file.printActive, hasDoc],
];

/** Documentos já vistos (para pôr nos Recentes só os recém-abertos). */
const seen = new Set<number>();

function trackRecents(): () => void {
  const sync = () => {
    for (const d of useDocs.getState().docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      if (d.path && !d.error) addRecent(d.path);
    }
  };
  sync();
  return useDocs.subscribe(sync);
}

/** Registra comandos, faixa, vigia e o fechar da janela; devolve a função que desfaz tudo. */
export function registerFileCommands(): () => void {
  const offs = ENTRIES.map(([id, run, enabled]) => registerCommand(id, run, enabled));
  setSaveHandler(file.saveDoc);
  offs.push(registerSlot("below-toolbar", "disk-banner", DiskBanner));
  offs.push(trackRecents());
  offs.push(
    subscribe(
      listen<DiskChanged>(DOC_CHANGED_ON_DISK_EVENT, (e) => file.markChanged(e.payload.id, e.payload.removed)),
    ),
  );
  // Fechar a janela com alterações pergunta antes (Salvar / Não Salvar / Cancelar).
  offs.push(
    subscribe(
      getCurrentWindow().onCloseRequested(async (e) => {
        if (!(await confirmAndSave(useDocs.getState().docs))) e.preventDefault();
      }),
    ),
  );
  return () => offs.forEach((off) => off());
}
