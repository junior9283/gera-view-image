// Diálogos do Lote 5 (navegador de versões e confirmação de descartar alterações), montados pelo slot
// `above-content`, que existe também em tela cheia (o Ctrl+Backspace funciona lá).
import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../lib/modal";
import { useDocs } from "../store/docs";
import { answerConfirm, closeVersions, useFinderUi } from "./store";
import { VersionsBrowser } from "./VersionsBrowser";
import "../file/file.css";

function ConfirmDiscard({ name, text, ok, details }: { name: string; text: string; ok: string; details: string[] }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose: () => answerConfirm(false) });
  return (
    <div className="file-backdrop" role="presentation">
      <div ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{t(text, { name })}</h3>
        {details.length > 0 && (
          <ul className="file-hint">
            {details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" autoFocus onClick={() => answerConfirm(false)}>{t("finder.trash.cancel")}</button>
          <button type="button" className="file-primary" onClick={() => answerConfirm(true)}>{t(ok)}</button>
        </div>
      </div>
    </div>
  );
}

export function FinderHost() {
  const versions = useFinderUi((s) => s.versions);
  const confirm = useFinderUi((s) => s.confirm);
  const doc = useDocs((s) => (versions === null ? null : (s.docs.find((d) => d.id === versions) ?? null)));
  return (
    <>
      {doc && <VersionsBrowser key={doc.id} doc={doc} onClose={closeVersions} />}
      {confirm && <ConfirmDiscard key={confirm.id} name={confirm.name} text={confirm.text} ok={confirm.ok} details={confirm.details} />}
    </>
  );
}
