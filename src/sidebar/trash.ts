// Mover para o Lixo a seleção da barra lateral ou da folha de contatos. Nunca apaga.
import { notify, notifyError } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { askDiscard, closePopover } from "../finder/store";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { nameList, reportBatch, runBatch } from "./batch";

async function trash(id: DocId): Promise<void> {
  const name = useDocs.getState().docs.find((d) => d.id === id)?.name ?? "";
  await ipc.moveToTrash(id);
  // Já está no Lixo: não fechar não desfaz o mover, só avisa.
  await useDocs.getState().close(id).catch((e: unknown) => {
    console.error(e);
    notify(i18n.t("finder.trash.notClosed", { name }));
  });
}

/**
 * Move os arquivos de `ids` para o Lixo e fecha os documentos. Com alterações não salvas, pergunta
 * uma vez por todos; `confirmMany` (atalho e menu Arquivo, que não dizem quantos) pergunta também
 * com 2 ou mais limpos, com Cancelar como padrão. Um arquivo que falha continua aberto e não impede
 * os demais; os erros viram aviso (nunca rejeição).
 */
export async function trashDocs(ids: DocId[], { confirmMany = false } = {}): Promise<void> {
  const docs = useDocs.getState().docs.filter((d) => ids.includes(d.id) && d.path);
  if (!docs.length) return;
  const dirty = docs.filter(hasUnsaved);
  if (dirty.length) {
    const text = dirty.length > 1 ? "finder.trash.confirmUnsavedMany" : "finder.trash.confirmUnsaved";
    if (!(await askDiscard(dirty[0].id, nameList(dirty.map((d) => d.name)), text, "finder.trash.ok"))) return;
  } else if (confirmMany && docs.length > 1) {
    if (!(await askDiscard(docs[0].id, String(docs.length), "finder.trash.confirmMany", "finder.trash.ok"))) return;
  }
  if (docs.length === 1) {
    try {
      await trash(docs[0].id);
      notify(i18n.t("finder.trash.done", { name: docs[0].name }));
    } catch (e) {
      notifyError(e);
    }
  } else {
    reportBatch(await runBatch(docs.map((d) => d.id), trash), "finder.trash.doneMany");
  }
  closePopover();
}
