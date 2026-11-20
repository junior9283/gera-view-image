import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { dismissToast, getToasts, subscribeToasts } from "./notify";

/** Pilha de avisos no canto inferior (erros de ações de menu/atalho). */
export function ToastHost() {
  const { t } = useTranslation();
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" role="alert">
          <span>{toast.text}</span>
          <button type="button" className="toast-close" aria-label={t("toast.close")} onClick={() => dismissToast(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
