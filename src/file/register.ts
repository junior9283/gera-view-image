// Liga o menu Arquivo ao registro de comandos, a faixa de alteração externa ao slot
// `below-toolbar` e os abertos aos Recentes. Fechar a janela: `tabs/closing.ts`.
import { subscribe } from "../lib/events";
import { registerDocState } from "../lib/docState";
import { registerSlot } from "../lib/slots";
import { listenHere } from "../lib/window";
import { flattenAnnotations } from "../markup/flatten";
import { DOC_CHANGED_ON_DISK_EVENT, type DiskChanged } from "../ipc/types";
import { registerCommand, type CommandId } from "../shortcuts/commands";
import { OPEN_RECENT_EVENT } from "../shortcuts/events";
import { useDocs } from "../store/docs";
import { addRecent, getPrefs } from "../store/prefs";
import { registerBeforeSave } from "./beforeSave";
import { hasUnsaved } from "./dirty";
import * as file from "./fileActions";
import { DiskBanner } from "./DiskBanner";
import { setSaveHandler } from "./unsaved";

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
  ["file.openRecent", () => window.dispatchEvent(new Event(OPEN_RECENT_EVENT)), () => getPrefs().recent.length > 0],
  ["file.save", () => {
    const d = file.current();
    return d && file.saveDoc(d);
  }, () => {
    const d = file.current();
    return !!d && (hasUnsaved(d) || !d.writable);
  }],
  ["file.duplicate", file.duplicateActive, hasDoc],
  ["file.rename", withDoc((id) => file.openFileDialog({ kind: "rename", id })), hasFile],
  ["file.moveTo", file.moveActive, hasFile],
  ["file.showInFolder", file.showInFolder, hasFile],
  ["file.openWith", file.openWith, hasFile],
  ["file.revertLastSaved", () => file.revert("lastSaved"), () => {
    const d = file.current();
    return !!d?.path && hasUnsaved(d);
  }],
  ["file.revertOriginal", () => file.revert("original"), () => hasFile() && !!(file.current()?.canUndo || file.current()?.dirty)],
  ["file.export", withDoc((id) => file.openFileDialog({ kind: "export", id, mode: "export" })), hasDoc],
  ["file.exportSelected", () => file.openFileDialog({ kind: "exportSelected" }), exportable],
  ["file.captureSelection", file.capture("selection")],
  ["file.captureWindow", file.capture("window")],
  ["file.captureScreen", file.capture("screen")],
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

/** Registra comandos, faixa e vigia; devolve a função que desfaz tudo. */
export function registerFileCommands(): () => void {
  const offs = ENTRIES.map(([id, run, enabled]) => registerCommand(id, run, enabled));
  setSaveHandler(file.saveDoc);
  // Anotações da Marcação (Task 8) viram pixels (Op::Composite) antes de qualquer gravação.
  offs.push(registerBeforeSave(async (id, page) => void (await flattenAnnotations(id, page))));
  offs.push(registerSlot("below-toolbar", "disk-banner", DiskBanner));
  offs.push(trackRecents());
  offs.push(
    subscribe(listenHere<DiskChanged>(DOC_CHANGED_ON_DISK_EVENT, (c) => file.markChanged(c.id, c.removed))),
  );
  // A faixa acompanha o documento que muda de janela (o vigia só avisa uma vez).
  offs.push(
    registerDocState("diskChange", {
      dump: (id) => file.useFileUi.getState().changed[id],
      load: (id, removed) => {
        if (!(id in file.useFileUi.getState().changed)) file.markChanged(id, removed === true);
      },
      drop: (id) => file.markChanged(id, null),
    }),
  );
  // Vindo de outra janela, já foi posto nos Recentes ao abrir.
  offs.push(registerDocState("recent", { dump: () => true, load: (id) => seen.add(id) }));
  return () => offs.forEach((off) => off());
}
