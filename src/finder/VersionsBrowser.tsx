// "Reverter Para ▸ Procurar Todas as Versões…": a versão atual ao lado da escolhida, com a lista
// das versões guardadas a cada Salvar. Restaurar troca o conteúdo sem gravar (o Salvar grava).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { formatBytes } from "../file/estimate";
import * as ipc from "../ipc/commands";
import type { DocInfo, FileVersion, ViewBuffer } from "../ipc/types";
import { useModal } from "../lib/modal";
import { restoreVersion } from "./actions";
import { useFinderUi } from "./store";
import "../file/file.css";
import "./finder.css";

const PREVIEW = 320;

function Preview({ load, label }: { load: () => Promise<ViewBuffer>; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load().then(
      (buf) => {
        const c = canvas.current;
        if (!live || !c) return;
        c.width = buf.width;
        c.height = buf.height;
        c.getContext("2d")?.putImageData(new ImageData(buf.data, buf.width, buf.height), 0, 0);
      },
      (e) => {
        if (live) setFailed(true);
        console.error(e);
      },
    );
    return () => {
      live = false;
    };
  }, [load]);
  return (
    <figure className="finder-preview">
      <canvas ref={canvas} role="img" aria-label={label} />
      <figcaption>{label}</figcaption>
      {failed && <span className="finder-hint">—</span>}
    </figure>
  );
}

export function VersionsBrowser({ doc, onClose }: { doc: DocInfo; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Com a confirmação de descartar aberta por cima, ela é que prende o foco.
  const asking = useFinderUi((s) => s.confirm !== null);
  useModal(dialog, { onClose, active: !asking });
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    ipc.listVersions(doc.id).then(
      (v) => {
        if (!live) return;
        setVersions(v);
        setChosen(v[0]?.id ?? null);
      },
      (e) => {
        if (live) setVersions([]);
        notifyError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [doc.id]);

  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  const loadCurrent = useCallback(() => ipc.thumbnail(doc.id, 0, PREVIEW), [doc.id]);
  const loadChosen = useCallback(() => ipc.versionPreview(doc.id, chosen ?? "", PREVIEW), [doc.id, chosen]);

  const restore = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      if (await restoreVersion(doc.id, chosen)) return onClose();
    } catch (e) {
      notifyError(e);
    }
    setBusy(false);
  };

  const chosenVersion = versions?.find((v) => v.id === chosen);
  return (
    <div className="file-backdrop" role="presentation">
      <div ref={dialog} className="file-dialog finder-versions" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{t("finder.versions.title", { name: doc.name })}</h3>
        {versions && !versions.length ? (
          <p className="file-hint">{t("finder.versions.empty")}</p>
        ) : (
          <div className="finder-versions-body">
            <ul className="finder-version-list" aria-label={t("finder.versions.list")}>
              {versions?.map((v) => (
                <li key={v.id}>
                  <button
                    type="button" aria-pressed={v.id === chosen} onClick={() => setChosen(v.id)}
                  >
                    <span>{date.format(new Date(v.savedAt))}</span>
                    <span className="finder-hint">{formatBytes(v.size, i18n.language)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="finder-compare">
              <Preview load={loadCurrent} label={t("finder.versions.current")} />
              {chosenVersion && (
                <Preview key={chosen} load={loadChosen} label={date.format(new Date(chosenVersion.savedAt))} />
              )}
            </div>
          </div>
        )}
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" onClick={onClose}>{t("finder.versions.close")}</button>
          <button type="button" className="file-primary" disabled={!chosen || busy} onClick={() => void restore()}>
            {t("finder.versions.restore")}
          </button>
        </div>
      </div>
    </div>
  );
}
