// Barra de abas (Visualizar › Mostrar Barra de Abas): uma aba por documento da janela.
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { hasUnsaved, subscribeDirty } from "../file/dirty";
import type { DocId } from "../ipc/types";
import { runCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { activate, closeDocs } from "../viewer/actions";
import { CloseTab } from "./CloseTab";
import "./tabs.css";

/** Área que a aba controla (`App`). */
export const TAB_PANEL_ID = "app-body";

export function TabBar() {
  const shown = usePrefs((p) => p.tabBar);
  const fullscreen = useUi((s) => s.fullscreen);
  const empty = useDocs((s) => !s.docs.length);
  return shown && !fullscreen && !empty ? <Tabs /> : null;
}

function Tabs() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  // Anotações e outras alterações fora do `DocInfo` também acendem o ponto.
  useSyncExternalStore(subscribeDirty, () => docs.map((d) => (hasUnsaved(d) ? 1 : 0)).join(""));
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    // O foco acompanha a aba ativa enquanto estiver na barra (setas, aba fechada).
    if (list.current?.contains(document.activeElement)) tab.focus();
  }, [activeId]);

  const close = (id: DocId) => {
    // A aba que recebe o foco é a que ficar ativa; se a focada sumir, o foco iria para o corpo da página.
    const focused = list.current?.contains(document.activeElement);
    void closeDocs([id]).then(() => {
      if (focused) list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const at = docs.findIndex((d) => d.id === activeId);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: docs.length - 1 }[e.key];
    if (to !== undefined) activate(docs[(to + docs.length) % docs.length].id);
    else if (e.key === "Delete" && activeId !== null) close(activeId);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="tab-bar">
      <div ref={list} className="tab-list" role="tablist" aria-label={t("tabs.bar")} onKeyDown={onKeyDown}>
        {docs.map((d) => {
          const selected = d.id === activeId;
          const unsaved = hasUnsaved(d);
          return (
            <div
              key={d.id}
              className={`tab${selected ? " selected" : ""}`}
              role="presentation"
              onAuxClick={(e) => e.button === 1 && close(d.id)}
            >
              <button
                type="button"
                className="tab-name"
                role="tab"
                aria-selected={selected}
                aria-controls={TAB_PANEL_ID}
                aria-label={unsaved ? t("tabs.unsaved", { name: d.name }) : undefined}
                tabIndex={selected ? 0 : -1}
                title={d.path || d.name}
                onClick={() => activate(d.id)}
              >
                {unsaved && <span className="tab-dot" aria-hidden />}
                <span className="tab-text">{d.name}</span>
              </button>
              <CloseTab name={d.name} tabIndex={-1} onClick={() => close(d.id)} />
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" aria-label={t("tabs.new")} title={t("tabs.new")} onClick={() => runCommand("file.open")}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
