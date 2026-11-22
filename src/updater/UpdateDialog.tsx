import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useModal } from "../lib/modal";
import { MAIN_WINDOW, windowLabel } from "../lib/window";
import "./update.css";
import { checkForUpdate, installUpdate, restartApp, RELEASES_URL, skipVersion, type UpdateInfo } from "./updater";

/** Evento que o menu Ajuda ▸ Verificar Atualizações… dispara. */
export const CHECK_UPDATES_EVENT = "gvi:check-updates";

/** Markdown simples (títulos, listas, parágrafos) sem HTML injetado. */
function Notes({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={`u${blocks.length}`}>{items.map((i, n) => <li key={n}>{i}</li>)}</ul>);
    items = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const li = /^[-*]\s+(.*)/.exec(line);
    if (li) items.push(li[1]);
    else {
      flush();
      const h = /^#{1,6}\s+(.*)/.exec(line);
      if (h) blocks.push(<h4 key={blocks.length}>{h[1]}</h4>);
      else if (line) blocks.push(<p key={blocks.length}>{line}</p>);
    }
  }
  flush();
  return <div className="update-notes">{blocks}</div>;
}

export function UpdateDialog({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [installed, setInstalled] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  // Esc não interrompe uma instalação em andamento.
  useModal(dialog, { onClose: () => !busy && onClose() });

  const install = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await installUpdate(setProgress);
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    const restarting = await restartApp().catch(() => false);
    // Instalou, mas não reiniciou (falhou ou o usuário cancelou): não é erro de instalação.
    setInstalled(!restarting);
    setBusy(restarting);
  };
  const openPage = () => openUrl(`${RELEASES_URL}${info.version}`);

  return (
    <div className="update-backdrop" role="presentation">
      <div ref={dialog} className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <h3 id="update-title">
          {t("update.title")}: v{info.version}
        </h3>
        <Notes text={info.notes} />
        {busy && <progress aria-label={t("update.installing")} value={progress ?? undefined} max={1} />}
        {installed && <p role="status">{t("update.installed")}</p>}
        {failed && (
          <p role="alert">
            {t("update.failed")}.{" "}
            <button onClick={openPage}>{t("update.openPage")}</button>
          </p>
        )}
        <div className="update-actions">
          <button onClick={install} disabled={busy || installed}>{t("update.install")}</button>
          <button onClick={onClose} disabled={busy}>{t("update.later")}</button>
          <button
            onClick={() => {
              skipVersion(info.version);
              onClose();
            }}
            disabled={busy}
          >
            {t("update.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Verifica 5 s após abrir e sob demanda (evento do menu); mostra o diálogo quando há versão nova. */
export function UpdateHost() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [upToDate, setUpToDate] = useState(false);

  const run = useCallback(async (manual: boolean) => {
    try {
      const found = await checkForUpdate({ manual });
      // A verificação automática sem resultado não pode fechar um diálogo já aberto.
      if (found) setInfo(found);
      else if (manual) setUpToDate(true);
    } catch {
      // Sem rede/endpoint: silencioso na verificação automática.
    }
  }, []);

  useEffect(() => {
    // A verificação automática é uma só, por mais janelas que se abram; a manual é da janela que pediu.
    const timer = windowLabel() === MAIN_WINDOW ? setTimeout(() => void run(false), 5000) : undefined;
    const onManual = () => void run(true);
    window.addEventListener(CHECK_UPDATES_EVENT, onManual);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CHECK_UPDATES_EVENT, onManual);
    };
  }, [run]);

  if (info) return <UpdateDialog info={info} onClose={() => setInfo(null)} />;
  if (upToDate) return <UpToDateDialog onClose={() => setUpToDate(false)} />;
  return null;
}

function UpToDateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose });
  return (
    <div className="update-backdrop" role="presentation">
      <div ref={dialog} className="update-dialog" role="dialog" aria-modal="true">
        <p>{t("update.upToDate")}</p>
        <div className="update-actions">
          <button onClick={onClose}>{t("update.close")}</button>
        </div>
      </div>
    </div>
  );
}
