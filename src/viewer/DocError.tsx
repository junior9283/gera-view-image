import { useTranslation } from "react-i18next";
import type { DocInfo } from "../ipc/types";

/** Ícone de arquivo com erro (também usado como miniatura de erro). */
export function ErrorIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="error-icon">
      <path d="M12 4h17l9 9v31H12z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M29 4v9h9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M19 22l10 10M29 22L19 32" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Estado de erro de um documento que não abriu: ícone, mensagem pelo código e nome do arquivo. */
export function DocError({ doc }: { doc: DocInfo }) {
  const { t } = useTranslation();
  return (
    <div className="doc-error" role="alert" data-testid="doc-error">
      <ErrorIcon />
      <strong>{t("error.title")}</strong>
      <span>{t(`error.${doc.error}`, { defaultValue: t("error.generic") })}</span>
      <span className="doc-error-name">{doc.name}</span>
    </div>
  );
}
