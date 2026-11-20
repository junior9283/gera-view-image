import { useCallback, useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./update.css";
import { checkForUpdate, installUpdate, restartApp, RELEASES_URL, skipVersion, type UpdateInfo } from "./updater";

// TODO(Tarefa de i18n): mover para i18next (pt-BR/en) quando o i18n existir; hoje só pt-BR.
const T = {
  title: "Nova versão disponível",
  install: "Instalar e Reiniciar",
  later: "Depois",
  skip: "Pular esta versão",
  installing: "Instalando…",
  failed: "Não foi possível instalar automaticamente",
  installed: "Atualização instalada. Reinicie o app para concluir.",
  openPage: "Abrir página da versão",
  upToDate: "Você já está na versão mais recente.",
  close: "Fechar",
};

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
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [installed, setInstalled] = useState(false);

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
    try {
      await restartApp();
    } catch {
      // Instalou, mas não reiniciou: não é erro de instalação.
      setInstalled(true);
      setBusy(false);
    }
  };
  const openPage = () => openUrl(`${RELEASES_URL}${info.version}`);

  return (
    <div className="update-backdrop" role="presentation">
      <div className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <h3 id="update-title">
          {T.title}: v{info.version}
        </h3>
        <Notes text={info.notes} />
        {busy && <progress aria-label={T.installing} value={progress ?? undefined} max={1} />}
        {installed && <p role="status">{T.installed}</p>}
        {failed && (
          <p role="alert">
            {T.failed}.{" "}
            <button onClick={openPage}>{T.openPage}</button>
          </p>
        )}
        <div className="update-actions">
          <button onClick={install} disabled={busy || installed}>{T.install}</button>
          <button onClick={onClose} disabled={busy}>{T.later}</button>
          <button
            onClick={() => {
              skipVersion(info.version);
              onClose();
            }}
            disabled={busy}
          >
            {T.skip}
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
    const timer = setTimeout(() => void run(false), 5000);
    const onManual = () => void run(true);
    window.addEventListener(CHECK_UPDATES_EVENT, onManual);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CHECK_UPDATES_EVENT, onManual);
    };
  }, [run]);

  if (info) return <UpdateDialog info={info} onClose={() => setInfo(null)} />;
  if (upToDate)
    return (
      <div className="update-backdrop" role="presentation">
        <div className="update-dialog" role="dialog" aria-modal="true">
          <p>{T.upToDate}</p>
          <div className="update-actions">
            <button onClick={() => setUpToDate(false)}>{T.close}</button>
          </div>
        </div>
      </div>
    );
  return null;
}
