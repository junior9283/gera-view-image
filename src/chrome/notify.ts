// Notificações centrais (toasts). `notifyError` traduz `AppError { code }` pela `errorMessage`.
import i18n, { errorMessage } from "../i18n";

export interface Toast {
  id: number;
  text: string;
}

const TOAST_MS = 5000;
/** Mais que isso, o mais antigo sai (uma rajada de erros não cobre a janela). */
const MAX_TOASTS = 3;
let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(list: Toast[]) {
  for (const [id, timer] of timers) {
    if (!list.some((t) => t.id === id)) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }
  toasts = list;
  listeners.forEach((l) => l());
}

export const subscribeToasts = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getToasts = () => toasts;

export const dismissToast = (id: number) => emit(toasts.filter((t) => t.id !== id));

function schedule(id: number) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
}

/** Mostra um aviso; o mesmo texto já visível só renova o prazo. */
export function notify(text: string): void {
  const same = toasts.find((t) => t.text === text);
  if (same) return schedule(same.id);
  const id = nextId++;
  schedule(id);
  emit([...toasts, { id, text }].slice(-MAX_TOASTS));
}

/** Código do `AppError` do Rust (`code`), se `e` for um. */
export const codeOf = (e: unknown): string | null => {
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
