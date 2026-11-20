// Notificações centrais (toasts). `notifyError` traduz `AppError { code }` pela `errorMessage`.
import i18n, { errorMessage } from "../i18n";

export interface Toast {
  id: number;
  text: string;
}

const TOAST_MS = 5000;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = (list: Toast[]) => {
  toasts = list;
  listeners.forEach((l) => l());
};

export const subscribeToasts = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getToasts = () => toasts;

export const dismissToast = (id: number) => emit(toasts.filter((t) => t.id !== id));

export function notify(text: string): void {
  const id = nextId++;
  emit([...toasts, { id, text }]);
  setTimeout(() => dismissToast(id), TOAST_MS);
}

const codeOf = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

/** Mostra o erro ao usuário (e no console). Códigos sem tradução viram a mensagem genérica. */
export function notifyError(e: unknown): void {
  console.error(e);
  const code = codeOf(e);
  notify(code && i18n.exists(`errors.${code}`) ? errorMessage(code) : i18n.t("errors.generic"));
}

/** Só para testes. */
export function resetToastsForTests(): void {
  emit([]);
}
