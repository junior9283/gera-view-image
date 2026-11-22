import { useTranslation } from "react-i18next";

/** Botão × de uma aba. `tabIndex` -1 onde o teclado fecha de outro jeito (Delete). */
export function CloseTab({ name, tabIndex, onClick }: { name: string; tabIndex?: number; onClick: () => void }) {
  const { t } = useTranslation();
  const label = t("tabs.close", { name });
  return (
    <button type="button" className="tab-close" tabIndex={tabIndex} aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}
