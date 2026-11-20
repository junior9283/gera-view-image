// Comandos de menu da Marcação (Ferramentas › Anotar ▸ e Visualizar › Barra de Marcação).
// A Task 6 liga cada um ao `registerCommand` dela.
import { useDocs } from "../store/docs";
import { toggleMarkupBar, useMarkup, type Tool } from "./store";

export interface MarkupCommand {
  id: string;
  run: () => void;
  enabled: () => boolean;
}

const ANNOTATE = ["rect", "oval", "line", "arrow", "text", "bubble", "star", "polygon", "loupe", "highlight", "signature"] as const;

const hasDoc = () => {
  const { docs, activeId } = useDocs.getState();
  return docs.some((d) => d.id === activeId && !d.error);
};

function annotate(kind: (typeof ANNOTATE)[number]) {
  const st = useMarkup.getState();
  st.setVisible(true);
  if (kind === "signature") st.setMenu("signature");
  else {
    st.setTool(kind as Tool);
    st.setMenu(null);
  }
}

export function markupCommands(): MarkupCommand[] {
  return [
    ...ANNOTATE.map((kind) => ({ id: `tools.annotate.${kind}`, run: () => annotate(kind), enabled: hasDoc })),
    { id: "view.markupBar", run: toggleMarkupBar, enabled: () => true },
  ];
}
