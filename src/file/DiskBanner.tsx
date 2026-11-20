import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { useDocs } from "../store/docs";
import { ignoreChange, reload, useFileUi } from "./fileActions";
import "./file.css";

/** Faixa "O arquivo foi alterado fora do app" do documento ativo (slot `below-toolbar`). */
export function DiskBanner() {
  const { t } = useTranslation();
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  const removed = useFileUi((s) => (doc ? s.changed[doc.id] : undefined));
  if (!doc || removed === undefined) return null;
  return (
    <div className="disk-banner" role="status" data-testid="disk-banner">
      <span>{t(removed ? "file.disk.removed" : "file.disk.changed", { name: doc.name })}</span>
      {!removed && (
        <button type="button" onClick={() => void reload(doc.id).catch(notifyError)}>{t("file.disk.reload")}</button>
      )}
      <button type="button" onClick={() => void ignoreChange(doc.id).catch(notifyError)}>{t("file.disk.ignore")}</button>
    </div>
  );
}
