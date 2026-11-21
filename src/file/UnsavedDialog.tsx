import { useId, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../lib/modal";
import { answerUnsaved, currentUnsaved, subscribeUnsaved } from "./unsaved";
import "./file.css";

/** Diálogo "Salvar alterações?" (montado uma vez pelo `FileHost`). */
export function UnsavedDialog() {
  const { t } = useTranslation();
  const req = useSyncExternalStore(subscribeUnsaved, currentUnsaved);
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // O botão padrão recebe o foco, como no Pré-Visualização.
  useModal(dialog, { active: !!req, initialFocus: primary, onClose: () => answerUnsaved("cancel") });
  if (!req) return null;
  const names = req.docs.map((d) => d.name);
  const reload = req.purpose === "reload";
  return (
    <div className="file-backdrop" role="presentation">
      <div
        ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        data-testid="unsaved-dialog"
      >
        <h3 id={titleId}>
          {reload
            ? t("file.unsaved.reloadTitle", { name: names[0] })
            : names.length === 1
              ? t("file.unsaved.titleOne", { name: names[0] })
              : t("file.unsaved.titleMany", { count: names.length })}
        </h3>
        {names.length > 1 && (
          <ul className="file-names">
            {names.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        <p>{t(reload ? "file.unsaved.reloadBody" : "file.unsaved.body")}</p>
        {reload ? (
          // Salvar por cima de um arquivo alterado fora do app falharia (`changed_on_disk`).
          <div className="file-actions">
            <span className="file-spacer" />
            <button type="button" ref={primary} onClick={() => answerUnsaved("cancel")}>{t("file.unsaved.cancel")}</button>
            <button type="button" className="file-primary" onClick={() => answerUnsaved("discard")}>
              {t("file.unsaved.reload")}
            </button>
          </div>
        ) : (
          <div className="file-actions">
            <button type="button" onClick={() => answerUnsaved("discard")}>{t("file.unsaved.discard")}</button>
            <span className="file-spacer" />
            <button type="button" onClick={() => answerUnsaved("cancel")}>{t("file.unsaved.cancel")}</button>
            <button type="button" ref={primary} className="file-primary" onClick={() => answerUnsaved("save")}>
              {t("file.unsaved.save")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
