// Comandos de menu da Marcação (Ferramentas › Anotar ▸ e Visualizar › Barra de Marcação),
// ligados ao registro da Task 6 por `registerMarkupCommands` (chamado no `register.ts`).
import { ANNOTATE_KINDS, registerCommand, type AnnotateKind, type CommandId } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { toggleMarkupBar, useMarkup } from "./store";

export interface MarkupCommand {
  id: CommandId;
  run: () => void;
  enabled: () => boolean;
}

const hasDoc = () => {
  const { docs, activeId } = useDocs.getState();
  return docs.some((d) => d.id === activeId && !d.error);
};

function annotate(kind: AnnotateKind) {
  const st = useMarkup.getState();
  st.setVisible(true);
  if (kind === "signature") st.setMenu("signature");
  else {
    st.setTool(kind);
    st.setMenu(null);
  }
}

export function markupCommands(): MarkupCommand[] {
  return [
    ...ANNOTATE_KINDS.map((kind) => ({ id: `tools.annotate.${kind}` as const, run: () => annotate(kind), enabled: hasDoc })),
    { id: "view.markupBar", run: toggleMarkupBar, enabled: () => true },
  ];
}

/** Registra os comandos; devolve a função que remove todos. */
export function registerMarkupCommands(): () => void {
  const offs = markupCommands().map((c) => registerCommand(c.id, c.run, c.enabled));
  return () => offs.forEach((off) => off());
}
