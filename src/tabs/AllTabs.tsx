// Mostrar Todas as Abas: miniaturas de todos os documentos da janela; escolher uma ativa a aba.
// E o véu que bloqueia a janela enquanto documentos mudam de janela ou ela fecha.
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { cancelQuit } from "../ipc/commands";
import { useModal } from "../lib/modal";
import { bucket } from "../sidebar/ContactSheet";
import { Thumb } from "../sidebar/Thumb";
import { useDocs } from "../store/docs";
import { activate, closeDocs } from "../viewer/actions";
import { answerQuestion, showOverview, useTabs, type Question, type Veil as VeilKind } from "./store";
import { CloseTab } from "./CloseTab";
import "../file/file.css";
import "./tabs.css";

const THUMB_PX = 160;

/** Índice vizinho na grade (colunas pela posição real dos itens). */
function neighbor(items: HTMLElement[], at: number, key: string): number | undefined {
  const top = items[0]?.offsetTop;
  const cols = Math.max(1, items.filter((el) => el.offsetTop === top).length);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: items.length - 1 }[key];
  return to === undefined ? undefined : Math.max(0, Math.min(items.length - 1, to));
}

function Overview() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const dialog = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  const close = () => showOverview(false);
  useModal(dialog, { onClose: close, initialFocus: current });

  const empty = docs.length === 0;
  useEffect(() => {
    if (empty) showOverview(false);
  }, [empty]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(".all-tabs-item")];
    const to = neighbor(items, items.indexOf(document.activeElement as HTMLElement), e.key);
    if (to === undefined) return;
    items[to]?.focus();
    e.preventDefault();
  };

  return (
    <div className="all-tabs" role="presentation" onClick={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialog} className="all-tabs-dialog" role="dialog" aria-modal="true" aria-label={t("tabs.all")}>
        <ul className="all-tabs-grid" onKeyDown={onKeyDown}>
          {docs.map((d) => (
            <li key={d.id}>
              <button
                ref={d.id === activeId ? current : undefined}
                type="button"
                className="all-tabs-item"
                aria-current={d.id === activeId || undefined}
                onClick={() => {
                  close();
                  activate(d.id);
                }}
              >
                <Thumb doc={d} size={THUMB_PX} fetchSize={bucket(THUMB_PX)} />
                <span className="all-tabs-name">{d.name}</span>
              </button>
              <CloseTab name={d.name} onClick={() => void closeDocs([d.id])} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Veil({ kind }: { kind: VeilKind }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  // Outra janela pode estar perguntando, talvez escondida atrás desta.
  const quitting = kind === "quitting";
  const cancel = () => void cancelQuit().catch(notifyError);
  useModal(root, { onClose: quitting ? cancel : undefined });
  return (
    <div ref={root} className="tabs-veil" role="dialog" aria-modal="true" aria-busy="true" aria-label={t(`tabs.${kind}`)} tabIndex={-1}>
      <div>
        <p>{t(`tabs.${kind}`)}</p>
        {quitting && (
          <>
            <p>{t("tabs.answerElsewhere")}</p>
            <button type="button" onClick={cancel}>{t("tabs.cancelQuit")}</button>
          </>
        )}
      </div>
    </div>
  );
}

/** Pergunta de sim ou não; Cancelar é o padrão. */
function AskDialog({ title, body, ok, cancel }: Question) {
  const titleId = useId();
  const bodyId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useModal(dialog, { initialFocus: first, onClose: () => answerQuestion(false) });
  return (
    <div className="file-backdrop tabs-question" role="presentation">
      <div ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}>
        <h3 id={titleId}>{title}</h3>
        <p id={bodyId}>{body}</p>
        <div className="file-actions">
          <button type="button" onClick={() => answerQuestion(true)}>{ok}</button>
          <span className="file-spacer" />
          <button type="button" ref={first} className="file-primary" onClick={() => answerQuestion(false)}>{cancel}</button>
        </div>
      </div>
    </div>
  );
}

/** Camadas de janela inteira das abas. */
export function TabsOverlays() {
  const overview = useTabs((s) => s.overview);
  const veil = useTabs((s) => s.veil);
  const question = useTabs((s) => s.question);
  return (
    <>
      {overview && <Overview />}
      {veil && <Veil key={veil} kind={veil} />}
      {question && <AskDialog {...question} />}
    </>
  );
}
