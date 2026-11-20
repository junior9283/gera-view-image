/** Eventos que o menu (Tarefa 6) e os atalhos disparam para abrir os diálogos. */
export const OPEN_PREFERENCES_EVENT = "gvi:open-preferences";
export const OPEN_ABOUT_EVENT = "gvi:open-about";

export const openPreferences = () => window.dispatchEvent(new Event(OPEN_PREFERENCES_EVENT));
export const openAbout = () => window.dispatchEvent(new Event(OPEN_ABOUT_EVENT));
