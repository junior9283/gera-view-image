// Lote 9 (Inspetor completo): Ferramentas > Descrição da Imagem… e a entrega, antes de gravar, dos
// textos editados no Inspetor. Importado uma vez no `main.tsx`. Guia: docs/arquitetura/extensao.md.
import { registerBeforeSave } from "../file/beforeSave";
import { editMetadata } from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { registerCommand } from "../shortcuts/commands";
import { activeDoc, viewable } from "../viewer/actions";
import { getPendingTextEdits } from "./textEdits";
import { openInspectorTab } from "./toggle";

registerCommand("tools.imageDescription", () => openInspectorTab("description"), () => viewable(activeDoc()));

/** Documentos cujas edições já foram para o Rust: um envio vazio só é preciso para limpá-las. */
const sent = new Set<DocId>();

registerBeforeSave(async (id) => {
  const pending = getPendingTextEdits(id);
  if (!pending && !sent.has(id)) return;
  await editMetadata(id, pending ?? {});
  if (pending) sent.add(id);
  else sent.delete(id);
});
