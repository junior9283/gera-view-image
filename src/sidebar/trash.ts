// Mover para o Lixo a seleção da barra lateral ou da folha de contatos. Nunca apaga.
import { notify } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { askDiscard, closePopover } from "../finder/store";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { nameList, reportBatch, runBatch } from "./batch";

async function trash(id: DocId): Promise<void> {
  await ipc.moveToTrash(id);
  await useDocs.getState().close(id);
}

/**
 * Move os arquivos de `ids` para o Lixo e fecha os documentos. Com alterações não salvas, pergunta
 * uma vez por todos. Um arquivo que falha continua aberto e não impede os demais.
 */
export async function trashDocs(ids: DocId[]): Promise<void> {
  const docs = useDocs.getState().docs.filter((d) => ids.includes(d.id) && d.path);
  if (!docs.length) return;
  const dirty = docs.filter(hasUnsaved);
  if (dirty.length) {
    const text = dirty.length > 1 ? "finder.trash.confirmUnsavedMany" : "finder.trash.confirmUnsaved";
    if (!(await askDiscard(dirty[0].id, nameList(dirty.map((d) => d.name)), text, "finder.trash.ok"))) return;
  }
  if (docs.length === 1) {
    await trash(docs[0].id);
    notify(i18n.t("finder.trash.done", { name: docs[0].name }));
  } else {
    reportBatch(await runBatch(docs.map((d) => d.id), trash), "finder.trash.doneMany");
  }
  closePopover();
}
