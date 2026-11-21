// Diálogos do Lote 5 (navegador de versões e confirmação do Lixo), montados pelo slot
// `above-content`, que existe também em tela cheia (o Ctrl+Backspace funciona lá).
import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../lib/modal";
import { useDocs } from "../store/docs";
import { answerTrash, closeVersions, useFinderUi } from "./store";
import { VersionsBrowser } from "./VersionsBrowser";
import "../file/file.css";

function TrashConfirm({ name }: { name: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose: () => answerTrash(false) });
  return (
    <div className="file-backdrop" role="presentation">
      <div ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{t("finder.trash.confirmUnsaved", { name })}</h3>
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" autoFocus onClick={() => answerTrash(false)}>{t("finder.trash.cancel")}</button>
          <button type="button" className="file-primary" onClick={() => answerTrash(true)}>{t("finder.trash.ok")}</button>
        </div>
      </div>
    </div>
  );
}

export function FinderHost() {
  const versions = useFinderUi((s) => s.versions);
  const confirm = useFinderUi((s) => s.confirmTrash);
  const doc = useDocs((s) => (versions === null ? null : (s.docs.find((d) => d.id === versions) ?? null)));
  return (
    <>
      {doc && <VersionsBrowser key={doc.id} doc={doc} onClose={closeVersions} />}
      {confirm && <TrashConfirm key={confirm.id} name={confirm.name} />}
    </>
  );
}
