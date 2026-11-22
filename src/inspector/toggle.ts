/** Evento que a Task 6 liga ao Ctrl+I e ao menu Ferramentas > Informações. */
export const TOGGLE_INSPECTOR_EVENT = "gvi:toggle-inspector";
/** Abre o Inspetor (se estiver fechado) já numa aba: Ferramentas > Descrição da Imagem… */
export const OPEN_INSPECTOR_TAB_EVENT = "gvi:open-inspector-tab";

export const toggleInspector = () => window.dispatchEvent(new Event(TOGGLE_INSPECTOR_EVENT));

export const openInspectorTab = (tab: string) =>
  window.dispatchEvent(new CustomEvent<string>(OPEN_INSPECTOR_TAB_EVENT, { detail: tab }));
