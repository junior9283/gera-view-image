import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../lib/modal";
import { answerDownload, cancelSubject, useSubject } from "./actions";
import "../file/file.css";
import "./subject.css";

/** Pergunta do download do modelo e faixa "procurando o objeto" com Cancelar (slot `above-content`). */
export function SubjectHost() {
  const { t } = useTranslation();
  const phase = useSubject((s) => s.phase);
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useModal(dialog, { active: phase.kind === "ask", initialFocus: primary, onClose: () => answerDownload(false) });
  if (phase.kind === "busy") {
    return (
      <div className="subject-busy" role="status" data-testid="subject-busy">
        <span className="subject-spinner" aria-hidden="true" />
        <span>{t(phase.downloading ? "subject.downloading" : "subject.busy")}</span>
        <button type="button" onClick={cancelSubject}>{t("subject.cancel")}</button>
      </div>
    );
  }
  if (phase.kind !== "ask") return null;
  return (
    <div className="file-backdrop" role="presentation">
      <div
        ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        data-testid="subject-ask"
      >
        <h3 id={titleId}>{t("subject.askTitle")}</h3>
        <p>{t("subject.askBody")}</p>
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" onClick={() => answerDownload(false)}>{t("subject.cancel")}</button>
          <button type="button" ref={primary} className="file-primary" onClick={() => answerDownload(true)}>
            {t("subject.download")}
          </button>
        </div>
      </div>
    </div>
  );
}
