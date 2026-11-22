// Eventos que a janela recebe do Rust e do sistema (Lote 12).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { notifyError } from "../chrome/notify";
import * as ipc from "../ipc/commands";
import {
  ACTIVATE_DOCUMENT_EVENT, CLOSE_WINDOW_EVENT, CONFIRM_CLOSE_EVENT, DOCS_INCOMING_EVENT, MERGE_REQUEST_EVENT,
  QUIT_CANCELLED_EVENT, WINDOWS_CHANGED_EVENT, type DocId, type WindowEntry,
} from "../ipc/types";
import { listenHere } from "../lib/window";
import { useDocs } from "../store/docs";
import { activate, activeDoc } from "../viewer/actions";
import { answerQuit, closeThisWindow, quitCancelled, sendAllTo } from "./closing";
import { setWindows } from "./store";
import { receiveDocs } from "./transfer";

const report = (work: Promise<unknown>) => void work.catch(notifyError);

const APP_TITLE = "Gera View Image";
/** O da configuração da janela, até haver documento. */
let title = APP_TITLE;

/** O título da janela no sistema (e no menu Janela) é o do documento ativo. */
function syncTitle(): void {
  const next = activeDoc()?.name ?? APP_TITLE;
  if (next === title) return;
  title = next;
  ipc.setWindowTitle(next).catch(() => {});
}

/**
 * Liga os eventos da janela. Chamado uma vez, antes de ela receber documentos (`initDocs`): sem o
 * ouvinte de fechar, uma janela com documentos poderia fechar sem perguntar.
 */
export async function installWindowEvents(): Promise<void> {
  await Promise.all([
    getCurrentWindow().onCloseRequested((e) => {
      // Quem fecha é o Rust, depois de tudo perguntado.
      e.preventDefault();
      report(closeThisWindow());
    }),
    listenHere<void>(CLOSE_WINDOW_EVENT, () => report(closeThisWindow())),
    listenHere<void>(CONFIRM_CLOSE_EVENT, () => {
      getCurrentWindow().setFocus().catch(() => {});
      report(answerQuit());
    }),
    listenHere<void>(QUIT_CANCELLED_EVENT, quitCancelled),
    listenHere<void>(DOCS_INCOMING_EVENT, () => report(receiveDocs())),
    listenHere<string>(MERGE_REQUEST_EVENT, (to) => report(sendAllTo(to))),
    listenHere<DocId>(ACTIVATE_DOCUMENT_EVENT, (id) => {
      if (useDocs.getState().docs.some((d) => d.id === id)) activate(id);
    }),
    listenHere<WindowEntry[]>(WINDOWS_CHANGED_EVENT, setWindows),
  ]);
  syncTitle();
  useDocs.subscribe(syncTitle);
  report(ipc.listWindows().then((list) => setWindows(list ?? [])));
}
