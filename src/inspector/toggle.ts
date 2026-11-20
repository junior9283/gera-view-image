/** Evento que a Task 6 liga ao Ctrl+I e ao menu Ferramentas > Informações. */
export const TOGGLE_INSPECTOR_EVENT = "gvi:toggle-inspector";

export const toggleInspector = () => window.dispatchEvent(new Event(TOGGLE_INSPECTOR_EVENT));
