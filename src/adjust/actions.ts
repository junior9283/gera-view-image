/** Eventos que o menu e os atalhos (Tarefa 6) disparam para abrir as ferramentas de ajuste. */
export const OPEN_ADJUST_COLOR_EVENT = "gvi:open-adjust-color";
export const OPEN_RESIZE_EVENT = "gvi:open-resize";

export const openAdjustColor = () => window.dispatchEvent(new Event(OPEN_ADJUST_COLOR_EVENT));
export const openResize = () => window.dispatchEvent(new Event(OPEN_RESIZE_EVENT));
