import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWindowEvent } from "../lib/events";
import { commandsVersion, isEnabled, runCommand, subscribeCommands, type CommandId } from "../shortcuts/commands";
import { KEYMAP, formatShortcut } from "../shortcuts/keymap";
import { MENUS, type MenuItem } from "./menus";

type Entry = Exclude<MenuItem, { separator: true }>;

const enabled = (i: Entry): boolean => (i.submenu ? i.submenu.some((s) => !("separator" in s) && enabled(s)) : isEnabled(i.command));

/** Itens focáveis da própria lista (sem os dos submenus). */
const rows = (ul: HTMLElement) => Array.from(ul.querySelectorAll<HTMLElement>(":scope > li[role=menuitem]"));

interface ListProps {
  label: string;
  items: MenuItem[];
  /** 0 = menu da barra; >0 = submenu. */
  level: number;
  autoFocus: boolean;
  onRun: (id: CommandId) => void;
  /** Fecha esta lista (no submenu, volta ao item pai). */
  onClose: () => void;
  /** Fecha tudo e devolve o foco ao app. */
  onCloseAll: () => void;
  /** Vai para o menu vizinho da barra. */
  onSwitch: (dir: 1 | -1) => void;
}

/** Lista de menu acessível (também usada pelo botão Compartilhar da barra de ferramentas). */
export function MenuList({ label, items, level, autoFocus, onRun, onClose, onCloseAll, onSwitch }: ListProps) {
  const { t } = useTranslation();
  const ul = useRef<HTMLUListElement>(null);
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);

  useEffect(() => {
    if (autoFocus && ul.current) rows(ul.current)[0]?.focus();
  }, [autoFocus]);

  const activate = (it: Entry, index: number, focus: boolean) => {
    if (!enabled(it)) return;
    if (it.submenu) setSub({ index, focus });
    else onRun(it.command);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const list = rows(e.currentTarget);
    const at = list.findIndex((li) => li.contains(e.target as Node));
    const focusAt = (i: number) => list[(i + list.length) % list.length]?.focus();
    const it = at >= 0 ? (items.filter((x) => !("separator" in x))[at] as Entry) : null;
    switch (e.key) {
      case "ArrowDown": focusAt(at + 1); break;
      case "ArrowUp": focusAt(at < 0 ? -1 : at - 1); break;
      case "Home": focusAt(0); break;
      case "End": focusAt(-1); break;
      case "Enter":
      case " ":
        if (it) activate(it, at, true);
        break;
      case "ArrowRight":
        if (it?.submenu && enabled(it)) setSub({ index: at, focus: true });
        else onSwitch(1);
        break;
      case "ArrowLeft":
        if (level > 0) onClose();
        else onSwitch(-1);
        break;
      case "Escape":
        if (level > 0) onClose();
        else onCloseAll();
        break;
      case "Tab":
        onCloseAll();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  let index = -1;
  return (
    <ul ref={ul} className={`menu menu-level-${level}`} role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((it, key) => {
        if ("separator" in it) return <li key={key} role="separator" className="menu-separator" />;
        const i = ++index;
        const on = enabled(it);
        return (
          <li
            key={key}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={!on}
            aria-haspopup={it.submenu ? "menu" : undefined}
            aria-expanded={it.submenu ? sub?.index === i : undefined}
            className="menu-item"
            onMouseEnter={() => setSub(it.submenu && on ? { index: i, focus: false } : null)}
            onClick={(e) => {
              e.stopPropagation();
              activate(it, i, false);
            }}
          >
            <span className="menu-label">{t(it.label)}</span>
            {it.submenu ? (
              <span className="menu-arrow" aria-hidden>▸</span>
            ) : (
              <span className="menu-shortcut">{formatShortcut(KEYMAP[it.command])}</span>
            )}
            {it.submenu && sub?.index === i && (
              <MenuList
                label={t(it.label)}
                items={it.submenu}
                level={level + 1}
                autoFocus={sub.focus}
                onRun={onRun}
                onClose={() => {
                  setSub(null);
                  if (ul.current) rows(ul.current)[i]?.focus();
                }}
                onCloseAll={onCloseAll}
                onSwitch={onSwitch}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Barra de menus (Arquivo … Ajuda). Alt ou F10 abre; setas navegam; Esc fecha e devolve o foco. */
export function MenuBar() {
  const { t } = useTranslation();
  useSyncExternalStore(subscribeCommands, commandsVersion);
  const [open, setOpen] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  /** Quem tinha o foco antes do menu: recebe-o de volta ao fechar. */
  const restore = useRef<HTMLElement | null>(null);
  /** Alt pressionado sem outra tecla depois. */
  const armed = useRef(false);

  const show = (i: number) => {
    if (open === null && !bar.current?.contains(document.activeElement)) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOpen((i + MENUS.length) % MENUS.length);
  };

  const close = (refocus = true) => {
    setOpen(null);
    const el = restore.current;
    restore.current = null;
    if (!refocus) return;
    if (el?.isConnected && el !== document.body) el.focus();
    else if (bar.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };
  const toggle = () => (open === null ? show(0) : close());

  // Alt sozinho (sem outra tecla no meio) ou F10 abre/fecha.
  useWindowEvent("keydown", (e) => {
    armed.current = e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    if (e.key === "F10" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      toggle();
    }
  });
  useWindowEvent("keyup", (e) => {
    if (e.key !== "Alt" || !armed.current) return;
    armed.current = false;
    e.preventDefault();
    toggle();
  });
  useWindowEvent("blur", () => (armed.current = false));

  // Clique fora fecha (o foco fica onde o usuário clicou).
  useWindowEvent("mousedown", (e) => {
    if (open !== null && !bar.current?.contains(e.target as Node)) close(false);
  });

  const run = (id: CommandId) => {
    close();
    runCommand(id);
  };

  return (
    <div ref={bar} className="menubar" role="menubar" aria-label={t("menu.bar")}>
      {MENUS.map((m, i) => (
        <div key={m.label} className="menubar-entry" role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-haspopup="menu"
            aria-expanded={open === i}
            className={`menubar-button${open === i ? " open" : ""}`}
            onClick={() => (open === i ? close() : show(i))}
            onMouseEnter={() => open !== null && open !== i && show(i)}
          >
            {t(m.label)}
          </button>
          {open === i && (
            <MenuList
              key={i}
              label={t(m.label)}
              items={m.items}
              level={0}
              autoFocus
              onRun={run}
              onClose={close}
              onCloseAll={close}
              onSwitch={(dir) => show(i + dir)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
