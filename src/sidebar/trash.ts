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
 * uma vez por todos (com o total e as que têm alterações); `confirmMany` (atalho e menu Arquivo, que não dizem quantos) pergunta também
 * com 2 ou mais limpos, com Cancelar como padrão. Um arquivo que falha continua aberto e não impede
 * os demais; os erros viram aviso (nunca rejeição).
 */
export async function trashDocs(ids: DocId[], { confirmMany = false } = {}): Promise<void> {
  const docs = useDocs.getState().docs.filter((d) => ids.includes(d.id) && d.path);
  if (!docs.length) return;
  const dirty = docs.filter(hasUnsaved);
  if (docs.length === 1 && dirty.length) {
    if (!(await askDiscard(docs[0].id, docs[0].name, "finder.trash.confirmUnsaved", "finder.trash.ok"))) return;
  } else if (dirty.length || (confirmMany && docs.length > 1)) {
    // A pergunta diz quantos vão ao Lixo e, à parte, quais têm alterações que se perdem.
    const unsaved = dirty.length
      ? [i18n.t("finder.trash.unsavedOf", { count: dirty.length, names: nameList(dirty.map((d) => d.name)) })]
      : [];
    if (!(await askDiscard(docs[0].id, String(docs.length), "finder.trash.confirmMany", "finder.trash.ok", unsaved))) return;
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
