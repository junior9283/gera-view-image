import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listProfiles, metadata } from "../ipc/commands";
import type { ColorProfile, DocInfo } from "../ipc/types";
import { useModal } from "../lib/modal";
import { useDocs } from "../store/docs";
import "../adjust/adjust.css";
import "./color.css";

/** Ferramentas › Atribuir Perfil…: reinterpreta os pixels com outro perfil ICC (desfaz com Ctrl+Z). */
export function AssignProfileDialog({ doc, onClose }: { doc: DocInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose });
  const [profiles, setProfiles] = useState<ColorProfile[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const name = metadata(doc.id).then((m) => m.general.profile, () => null);
    Promise.all([listProfiles(), name]).then(
      ([list, cur]) => {
        if (!live) return;
        setProfiles(list);
        setCurrent(cur);
        // Pré-seleciona o perfil com o mesmo nome do atual.
        setChosen(list.find((p) => p.name === cur)?.id ?? list[0]?.id ?? "");
      },
      () => live && setError(t("color.assign.failed")),
    );
    return () => {
      live = false;
    };
  }, [doc.id, t]);

  const ok = async () => {
    setError(null);
    try {
      await useDocs.getState().applyOp(doc.id, { type: "assignProfile", data: { profile: chosen } });
      onClose();
    } catch {
      setError(t("color.assign.failed"));
    }
  };

  return (
    <div className="adjust-backdrop" role="presentation">
      <div ref={dialog} className="adjust-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{t("color.assign.title")}</h3>
        <p className="color-hint">{t("color.assign.current", { name: current ?? t("color.assign.none") })}</p>
        <label className="adjust-row">
          <span>{t("color.assign.profile")}</span>
          {profiles ? (
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} data-testid="assign-profile">
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          ) : (
            <span>{t("color.assign.loading")}</span>
          )}
        </label>
        <p className="color-hint">{t("color.assign.hint")}</p>
        {error && <p role="alert" className="adjust-error">{error}</p>}
        <div className="adjust-actions">
          <span className="adjust-spacer" />
          <button type="button" onClick={onClose}>{t("color.assign.cancel")}</button>
          <button type="button" className="adjust-ok" onClick={() => void ok()} disabled={!chosen}>
            {t("color.assign.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
