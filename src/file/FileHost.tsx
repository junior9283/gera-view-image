import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { useDocs } from "../store/docs";
import { usePrefs, setPrefs } from "../store/prefs";
import { ExportDialog, ExportSelectedDialog } from "./ExportDialog";
import { closeFileDialog, openRecent, renameDoc, useFileUi } from "./fileActions";
import { registerFileCommands } from "./register";
import { UnsavedDialog } from "./UnsavedDialog";
import "./file.css";

function RenameDialog({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const [value, setValue] = useState(name);
  const ok = async () => {
    try {
      await renameDoc(id, value);
      onClose();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <div className="file-backdrop" role="presentation">
      <form
        className="file-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          void ok();
        }}
      >
        <h3 id={titleId}>{t("file.rename.title")}</h3>
        <label className="file-row">
          <span>{t("file.rename.name")}</span>
          <input
            type="text" value={value} autoFocus onChange={(e) => setValue(e.target.value)}
            // Seleciona só o nome, sem a extensão (como o Preview).
            onFocus={(e) => e.target.setSelectionRange(0, Math.max(0, value.lastIndexOf(".")) || value.length)}
          />
        </label>
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" onClick={onClose}>{t("file.rename.cancel")}</button>
          <button type="submit" className="file-primary" disabled={!value.trim() || value === name}>{t("file.rename.ok")}</button>
        </div>
      </form>
    </div>
  );
}

/** Abrir Recentes: lista simples (a barra de menus da Task 6 não tem submenus dinâmicos). */
function RecentDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const recent = usePrefs((p) => p.recent);
  return (
    <div className="file-backdrop" role="presentation">
      <div
        className="file-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h3 id={titleId}>{t("file.recent.title")}</h3>
        {recent.length ? (
          <ul className="file-list">
            {recent.map((p) => (
              <li key={p}>
                <button
                  type="button" title={p}
                  onClick={() => {
                    onClose();
                    void openRecent(p).catch(notifyError);
                  }}
                >
                  {p.slice(p.lastIndexOf("/") + 1)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="file-hint">{t("file.recent.empty")}</p>
        )}
        <div className="file-actions">
          <button type="button" disabled={!recent.length} onClick={() => setPrefs({ recent: [] })}>{t("file.recent.clear")}</button>
          <span className="file-spacer" />
          <button type="button" autoFocus onClick={onClose}>{t("file.recent.close")}</button>
        </div>
      </div>
    </div>
  );
}

/** Diálogos do menu Arquivo e o registro dos comandos (montado uma vez no `App`). */
export function FileHost() {
  useEffect(registerFileCommands, []);
  const dialog = useFileUi((s) => s.dialog);
  const doc = useDocs((s) =>
    dialog && "id" in dialog ? (s.docs.find((d) => d.id === dialog.id) ?? null) : null,
  );
  let content = null;
  if (dialog?.kind === "export" && doc) {
    content = <ExportDialog key={doc.id} doc={doc} mode={dialog.mode} onClose={closeFileDialog} />;
  } else if (dialog?.kind === "rename" && doc) {
    content = <RenameDialog key={doc.id} id={doc.id} name={doc.name} onClose={closeFileDialog} />;
  } else if (dialog?.kind === "exportSelected") {
    content = <ExportSelectedDialog onClose={closeFileDialog} />;
  } else if (dialog?.kind === "recent") {
    content = <RecentDialog onClose={closeFileDialog} />;
  }
  return (
    <>
      {content}
      <UnsavedDialog />
    </>
  );
}
