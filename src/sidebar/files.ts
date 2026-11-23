// Miniaturas como arquivos: copiar, colar e abrir numa posição (soltar na barra lateral ou na folha).
import { hasUnsaved } from "../file/dirty";
import { newFromClipboard } from "../file/fileActions";
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo } from "../ipc/types";
import { shownPage } from "../markup/pages";
import { flattenedIds } from "../print/print";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { getPrefs, setPrefs } from "../store/prefs";
import { runCommand } from "../shortcuts/commands";
import { openHere } from "../tabs/open";
import { activate } from "../viewer/actions";
import { dragPlan } from "./dragOut";
import { moveIds } from "./order";
import { selectedDocs, sheetOpen, useThumbSelection } from "./selection";

/** Leva `ids` (na ordem dada) para antes do item `to`. Vale como ordem manual: Ordenar Por não a desfaz. */
export function placeDocs(ids: DocId[], to: number): void {
  if (getPrefs().sortBy !== "manual") setPrefs({ sortBy: "manual" });
  const docs = useDocs.getState();
  docs.applyOrder(moveIds(docs.docs.map((d) => d.id), ids, to));
}

/** Copia as imagens como arquivos; as alteradas vão como PNG temporário, com as anotações. */
export async function copyThumbs(ids: DocId[]): Promise<void> {
  const docs = useDocs.getState().docs.filter((d) => ids.includes(d.id) && !d.error);
  if (!docs.length) return;
  const flat = await flattenedIds(docs.map((d) => d.id));
  try {
    const items = dragPlan(docs, hasUnsaved).map((item, i) =>
      flat.ids[i] === item.id ? item : { id: flat.ids[i], export: true },
    );
    await ipc.copyFiles(items, docs.length === 1 ? shownPage(docs[0].id) : 0);
  } finally {
    await flat.close();
  }
}

/**
 * Editar › Copiar age nas miniaturas? Sim na folha de contatos e com várias selecionadas na barra
 * lateral (sem seleção na imagem); senão `null` e vale o Copiar da imagem.
 */
export function copyAsFiles(): Promise<void> | null {
  const docs = selectedDocs();
  const several = docs.length > 1 && !useSelection.getState().selection;
  return sheetOpen() || several ? copyThumbs(docs.map((d) => d.id)) : null;
}

/** Abre `paths` antes do item `at`, na ordem, e os seleciona. */
export async function openAt(paths: string[], at: number): Promise<void> {
  // O item pode mudar de lugar enquanto os arquivos abrem (Ordenar Por).
  const next: DocInfo | undefined = useDocs.getState().docs[at];
  const opened = (await openHere(paths)).map((d) => d.id);
  if (!opened.length) return;
  const { docs } = useDocs.getState();
  const to = next ? docs.findIndex((d) => d.id === next.id) : -1;
  placeDocs(opened, to < 0 ? docs.length : to);
  useThumbSelection.setState({ picked: opened, anchor: opened[0] });
  activate(opened[0]);
}

/**
 * Colar na barra lateral ou na folha: os arquivos copiados abrem depois da seleção. Sem arquivos,
 * a folha abre a imagem copiada e a barra lateral segue o Colar de sempre (camada).
 */
export async function pasteThumbs(): Promise<void> {
  const files = await ipc.clipboardFiles();
  if (files.length) {
    const last = selectedDocs().pop()?.id;
    return openAt(files, useDocs.getState().docs.findIndex((d) => d.id === last) + 1);
  }
  if (sheetOpen()) return newFromClipboard();
  runCommand("edit.paste");
}
