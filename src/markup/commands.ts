// Comandos de menu da Marcação (Ferramentas › Anotar ▸ e Visualizar › Barra de Marcação),
// ligados ao registro da Task 6 por `registerMarkupCommands` (chamado no `register.ts`).
import { ANNOTATE_KINDS, registerCommand, type AnnotateKind, type CommandId } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { toggleMarkupBar, useMarkup, type BarMenu } from "./store";

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

function openPanel(menu: BarMenu) {
  const st = useMarkup.getState();
  st.setVisible(true);
  st.setMenu(st.menu === menu ? null : menu);
}

export function markupCommands(): MarkupCommand[] {
  return [
    ...ANNOTATE_KINDS.map((kind) => ({ id: `tools.annotate.${kind}` as const, run: () => annotate(kind), enabled: hasDoc })),
    { id: "view.markupBar", run: toggleMarkupBar, enabled: () => true },
    // Mostrar Cores, Mostrar Fontes e Inspetor de Marcação abrem o painel na barra de Marcação.
    { id: "tools.showColors", run: () => openPanel("colors"), enabled: hasDoc },
    { id: "tools.showFonts", run: () => openPanel("fonts"), enabled: hasDoc },
    { id: "tools.markupInspector", run: () => openPanel("properties"), enabled: hasDoc },
  ];
}

/** Registra os comandos; devolve a função que remove todos. */
export function registerMarkupCommands(): () => void {
  const offs = markupCommands().map((c) => registerCommand(c.id, c.run, c.enabled));
  return () => offs.forEach((off) => off());
}
