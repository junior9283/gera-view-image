// Liga a Marcação ao app sem editar os arquivos que a hospedam: camada no Viewport,
// barra abaixo da barra de ferramentas, desfazer unificado e lista do Inspetor.
// Importado uma vez no `main.tsx`.
import i18n from "../i18n";
import { setAnnotationSource } from "../inspector/annotations";
import { registerSlot } from "../lib/slots";
import { useDocs } from "../store/docs";
import { flattenAnnotations } from "./flatten";
import { installHistory } from "./history";
import { MarkupBar } from "./MarkupBar";
import { MarkupLayer } from "./MarkupLayer";
import "./markup.css";
import { TOGGLE_MARKUP_EVENT, getItems, toggleMarkupBar, useMarkup } from "./store";

installHistory();
registerSlot("viewport-overlay", "markup", MarkupLayer);
registerSlot("below-toolbar", "markup-bar", MarkupBar);
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

/**
 * Gancho do E2E (markup.e2e.ts): contar anotações e achatar sem depender do Salvar/Exportar
 * (Task 11). Não amplia nada: a página já tem o IPC inteiro.
 */
const active = () => useDocs.getState().activeId;
Object.assign(window, {
  __gviMarkup: {
    activeId: active,
    count: () => {
      const id = active();
      return id === null ? 0 : getItems(id).length;
    },
    flatten: () => {
      const id = active();
      return id === null ? Promise.resolve(false) : flattenAnnotations(id);
    },
  },
});
