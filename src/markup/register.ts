// Liga a Marcação ao app sem editar os arquivos que a hospedam: camada no Viewport,
// barra abaixo da barra de ferramentas, desfazer unificado, comandos de menu e lista do Inspetor.
// Importado uma vez no `main.tsx`.
import { registerDirtySource } from "../file/dirty";
import i18n from "../i18n";
import { setAnnotationSource } from "../inspector/annotations";
import { registerDocState } from "../lib/docState";
import { registerSlot } from "../lib/slots";
import { TOGGLE_MARKUP_EVENT } from "../shortcuts/events";
import { useDocs } from "../store/docs";
import { registerMarkupCommands } from "./commands";
import { flattenAnnotations } from "./flatten";
import { installHistory } from "./history";
import { Eyedropper } from "./Eyedropper";
import { MarkupBar } from "./MarkupBar";
import { MarkupLayer } from "./MarkupLayer";
import "./markup.css";
import type { Annotation } from "./model";
import { getItems, getSelected, toggleMarkupBar, useMarkup } from "./store";

installHistory();
registerMarkupCommands();
registerSlot("viewport-overlay", "markup", MarkupLayer);
// Anotações não achatadas são alteração não salva (pergunta ao fechar, habilita o Salvar).
registerDirtySource(
  (id) => getItems(id).length > 0,
  (cb) => useMarkup.subscribe((s, prev) => s.docs !== prev.docs && cb()),
  "markup",
);
// As anotações (e quais estão selecionadas) vão junto quando o documento muda de janela. Na origem,
// `history.ts` já as esquece quando o documento sai.
registerDocState("markup", {
  dump: (id) => (getItems(id).length ? { items: getItems(id), selected: getSelected(id) } : undefined),
  load: (id, data) => {
    const { items, selected } = data as { items: Annotation[]; selected: string[] };
    useMarkup.getState().setItems(id, items);
    useMarkup.getState().select(id, selected);
  },
});
registerSlot("below-toolbar", "markup-bar", MarkupBar);
registerSlot("viewport-overlay", "eyedropper", Eyedropper);
// Ouvinte de módulo (não de componente): a Toolbar e o Ctrl+Shift+M (Task 6) alternam a
// barra mesmo que nenhum slot esteja montado no momento.
window.addEventListener(TOGGLE_MARKUP_EVENT, toggleMarkupBar);

setAnnotationSource({
  list: (id) =>
    getItems(id).map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.kind === "text" ? a.geom.text.split("\n")[0].slice(0, 60) : i18n.t(`markup.kind.${a.kind}`),
    })),
  subscribe: (cb) => useMarkup.subscribe((s, prev) => s.docs !== prev.docs && cb()),
  select: (id, annotationId) => {
    const st = useMarkup.getState();
    st.setVisible(true);
    st.setTool("select");
    st.select(id, [annotationId]);
  },
});

// Gancho do E2E (markup.e2e.ts): só no build com VITE_E2E=1 (ver docs/testes/guia.md).
if (import.meta.env.VITE_E2E) {
  const active = () => useDocs.getState().activeId;
  const items = () => {
    const id = active();
    return id === null ? [] : getItems(id);
  };
  Object.assign(window, {
    __gviMarkup: {
      activeId: active,
      count: () => items().length,
      texts: () => items().flatMap((a) => (a.kind === "text" ? [a.geom.text] : [])),
      flatten: () => {
        const id = active();
        return id === null ? Promise.resolve(false) : flattenAnnotations(id);
      },
    },
  });
}
