import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { focusByKeys } from "../lib/tablist";
import { copySelected, lookUp, startSpeaking } from "./actions";

export interface MenuAt {
  /** Posição na camada, em px CSS. */
  x: number;
  y: number;
}

/** Menu de contexto do texto selecionado: Copiar, Pesquisar, Traduzir e Falar. */
export function LiveTextMenu({ at, onClose }: { at: MenuAt; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const item = (label: string, run: () => Promise<unknown>) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose();
        void run().catch(notifyError);
      }}
    >
      {label}
    </button>
  );
  return (
    <div ref={ref} className="livetext-menu" role="menu" aria-label={t("livetext.menu.label")} onKeyDown={(e) => focusByKeys(e, '[role="menuitem"]')} data-livetext-stop style={{ left: at.x, top: at.y }}>
      {item(t("livetext.menu.copy"), copySelected)}
      {item(t("livetext.menu.search"), () => lookUp("search"))}
      {item(t("livetext.menu.translate"), () => lookUp("translate"))}
      {item(t("livetext.menu.speak"), startSpeaking)}
    </div>
  );
}
