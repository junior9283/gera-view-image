import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { answerUnsaved, currentUnsaved, subscribeUnsaved } from "./unsaved";
import "./file.css";

/** Diálogo "Salvar alterações?" (montado uma vez pelo `FileHost`). */
export function UnsavedDialog() {
  const { t } = useTranslation();
  const req = useSyncExternalStore(subscribeUnsaved, currentUnsaved);
  const titleId = useId();
  const saveBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (req) saveBtn.current?.focus();
  }, [req]);
  if (!req) return null;
  const names = req.docs.map((d) => d.name);
  return (
    <div className="file-backdrop" role="presentation">
      <div
        className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        data-testid="unsaved-dialog"
        onKeyDown={(e) => e.key === "Escape" && answerUnsaved("cancel")}
      >
        <h3 id={titleId}>
          {names.length === 1 ? t("file.unsaved.titleOne", { name: names[0] }) : t("file.unsaved.titleMany", { count: names.length })}
        </h3>
        {names.length > 1 && (
          <ul className="file-names">
            {names.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        <p>{t("file.unsaved.body")}</p>
        <div className="file-actions">
          <button type="button" onClick={() => answerUnsaved("discard")}>{t("file.unsaved.discard")}</button>
          <span className="file-spacer" />
          <button type="button" onClick={() => answerUnsaved("cancel")}>{t("file.unsaved.cancel")}</button>
          <button type="button" ref={saveBtn} className="file-primary" onClick={() => answerUnsaved("save")}>
            {t("file.unsaved.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
