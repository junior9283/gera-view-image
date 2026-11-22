// Abrir arquivos a pedido do usuário conforme Preferências › Geral › Abrir arquivos: em abas, na
// mesma janela (barra lateral) ou em janelas separadas.
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { getPrefs, setPrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { openHere } from "../tabs/open";
import { moveDocs } from "../tabs/transfer";
import { activate } from "../viewer/actions";

export const openIds = (): DocId[] => useDocs.getState().docs.map((d) => d.id);

/** Cada janela é um WebView inteiro: abrir 50 arquivos de uma vez não pode criar 50 (memória). */
export const MAX_NEW_WINDOWS = 8;

/** Leva cada documento para uma janela própria, até `MAX_NEW_WINDOWS`; se um não puder ir, ele e os seguintes ficam. */
async function spread(docs: DocInfo[]): Promise<void> {
  for (const d of docs.slice(0, MAX_NEW_WINDOWS)) if (!(await moveDocs([d.id], ipc.newWindow))) return;
}

/** Mostra os documentos recém-abertos; `before` são os que a janela já tinha. */
export async function placeOpened(infos: DocInfo[], before: DocId[]): Promise<void> {
  if (getPrefs().openFilesIn === "windows") {
    const fresh = infos.filter((d) => !before.includes(d.id) && !d.error);
    await spread(before.length ? fresh : fresh.slice(1));
  }
  const here = openIds();
  const first = infos.find((d) => here.includes(d.id));
  if (first) activate(first.id);
}

/** Abre os arquivos e mostra o primeiro. */
export async function openFiles(paths: string[]): Promise<void> {
  const before = openIds();
  await placeOpened(await openHere(paths), before);
}

/** Janelas separadas: dos arquivos da linha de comando, só o primeiro fica nesta. */
export async function separateWindows(docs: DocInfo[]): Promise<void> {
  if (getPrefs().openFilesIn === "windows") await spread(docs.filter((d) => !d.error).slice(1));
}

/** A janela passou a ter mais de uma imagem: mostra a barra lateral ou a de abas. */
export function showMany(): void {
  const mode = getPrefs().openFilesIn;
  if (mode === "tabs") setPrefs({ tabBar: true });
  else if (mode === "window" && useUi.getState().sidebar === "hidden") useUi.getState().setSidebar("thumbs");
}
