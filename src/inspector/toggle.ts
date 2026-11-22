/** Evento que a Task 6 liga ao Ctrl+I e ao menu Ferramentas > Informações. */
export const TOGGLE_INSPECTOR_EVENT = "gvi:toggle-inspector";
/** Abre o Inspetor (se estiver fechado) já numa aba: Ferramentas > Descrição da Imagem… */
export const OPEN_INSPECTOR_TAB_EVENT = "gvi:open-inspector-tab";

export const toggleInspector = () => window.dispatchEvent(new Event(TOGGLE_INSPECTOR_EVENT));

export const openInspectorTab = (tab: string) =>
  window.dispatchEvent(new CustomEvent<string>(OPEN_INSPECTOR_TAB_EVENT, { detail: tab }));

// Estado do painel para o rótulo do menu (Mostrar/Ocultar Inspetor) e o botão da barra.
let open = false;
const listeners = new Set<() => void>();
export const inspectorOpen = () => open;
export function subscribeInspector(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** Quem monta o painel (`InspectorHost`) informa se ele está aberto. */
export function setInspectorOpen(v: boolean): void {
  if (open === v) return;
  open = v;
  listeners.forEach((l) => l());
}

/** Só para testes. */
export const resetInspectorForTests = () => setInspectorOpen(false);
