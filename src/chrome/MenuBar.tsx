import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import { useWindowEvent } from "../lib/events";
import { windowLabel } from "../lib/window";
import { COMMAND_IDS, commandsVersion, isEnabled, runCommand, type CommandId } from "../shortcuts/commands";
import { subscribeEnabled } from "../shortcuts/useEnabled";
import { KEYMAP, formatShortcut } from "../shortcuts/keymap";
import { useTabs } from "../tabs/store";
import { useDynamicMenu } from "./dynamicMenus";
import { MENUS, type MenuItem } from "./menus";
import { searchMenus } from "./menuSearch";
import { notifyError } from "./notify";

/** Item calculado na hora (resultado da busca, app do Abrir com): texto já traduzido. */
export interface ActionItem {
  text: string;
  run: () => void;
  /** Texto à direita (no lugar do atalho). */
  hint?: string;
  disabled?: boolean;
  /** Item de escolha única (janela atual no menu Janela). */
  checked?: boolean;
  label?: never;
  command?: never;
  submenu?: never;
}
export type ListItem = MenuItem | ActionItem | { label: string; submenu: ListItem[]; command?: never };
type Entry = Exclude<ListItem, { separator: true }>;

const isAction = (i: Entry): i is ActionItem => "run" in i;
const enabled = (i: Entry): boolean =>
  isAction(i) ? !i.disabled : i.submenu ? i.submenu.some((s) => !("separator" in s) && enabled(s)) : isEnabled(i.command);

/** Ajuda › Pesquisar (Ctrl+?): abre o menu Ajuda com o foco no campo de busca. */
export const HELP_SEARCH_EVENT = "gvi:help-search";
const HELP = MENUS.findIndex((m) => m.label === "menu.help.title");
const WINDOW = MENUS.findIndex((m) => m.label === "menu.window.title");

/** Itens focáveis da própria lista (sem os dos submenus). */
const rows = (ul: HTMLElement) => Array.from(ul.querySelectorAll<HTMLElement>(":scope > li[role^=menuitem]"));

interface ListProps {
  label: string;
  /** Submenu de `menus.ts` (chave do rótulo): pode ter itens calculados na hora. */
  menuKey?: string;
  items: ListItem[];
  /** Primeira linha fixa, fora da navegação por setas (campo Pesquisar). */
  header?: ReactNode;
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
export function MenuList({ label, menuKey, items: fixed, header, level, autoFocus, onRun, onClose, onCloseAll, onSwitch }: ListProps) {
  const { t } = useTranslation();
  const ul = useRef<HTMLUListElement>(null);
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(null);
  const dynamic = useDynamicMenu(menuKey);
  // Só os submenus de `menus.ts` têm `menuKey`: os itens são `MenuItem`.
  const items = dynamic ? dynamic.build(fixed as MenuItem[]) : fixed;
  useEffect(() => dynamic?.onOpen?.(), [dynamic]);

  useEffect(() => {
    if (autoFocus && ul.current) rows(ul.current)[0]?.focus();
  }, [autoFocus]);

  const activate = (it: Entry, index: number, focus: boolean) => {
    if (!enabled(it)) return;
    if (isAction(it)) {
      onCloseAll();
      it.run();
    } else if (it.submenu) setSub({ index, focus });
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
    <ul ref={ul} className={`menu menu-level-${level}${dynamic ? " menu-scroll" : ""}`} role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {header && <li role="none" className="menu-header">{header}</li>}
      {items.map((it, key) => {
        if ("separator" in it) return <li key={key} role="separator" className="menu-separator" />;
        const i = ++index;
        const on = enabled(it);
        return (
          <li
            key={key}
            role={isAction(it) && it.checked !== undefined ? "menuitemradio" : "menuitem"}
            aria-checked={isAction(it) ? it.checked : undefined}
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
            <span className="menu-label">{isAction(it) ? it.text : t(it.label)}</span>
            {it.submenu ? (
              <span className="menu-arrow" aria-hidden>▸</span>
            ) : (
              <span className="menu-shortcut">{isAction(it) ? it.hint : formatShortcut(KEYMAP[it.command])}</span>
            )}
            {it.submenu && sub?.index === i && (
              <MenuList
                label={t(it.label)}
                menuKey={it.label}
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

interface SearchProps {
  value: string;
  onChange: (q: string) => void;
  /** Enter: executa o primeiro resultado. */
  onEnter: () => void;
  onCloseAll: () => void;
  onSwitch: (dir: 1 | -1) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/** Campo Pesquisar do menu Ajuda. Seta para baixo desce aos resultados; as demais teclas ficam no campo. */
function HelpSearch({ value, onChange, onEnter, onCloseAll, onSwitch, inputRef }: SearchProps) {
  const { t } = useTranslation();
  useEffect(() => inputRef.current?.focus(), [inputRef]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const ul = e.currentTarget.closest("ul");
    switch (e.key) {
      case "ArrowDown": if (ul) rows(ul)[0]?.focus(); break;
      case "Enter": onEnter(); break;
      case "Escape":
        if (value) onChange("");
        else onCloseAll();
        break;
      case "Tab": onCloseAll(); break;
      case "ArrowLeft":
      case "ArrowRight":
        if (value) return;
        onSwitch(e.key === "ArrowLeft" ? -1 : 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  return (
    <input
      ref={inputRef}
      type="search"
      className="menu-search"
      aria-label={t("menu.help.search")}
      placeholder={t("menu.help.search")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/** Barra de menus (Arquivo … Ajuda). Alt ou F10 abre; setas navegam; Esc fecha e devolve o foco. */
export function MenuBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  // Aberto, re-renderiza quando a habilitação de algum comando muda; fechado, só com o registro.
  useSyncExternalStore(subscribeEnabled, () =>
    open === null ? String(commandsVersion()) : COMMAND_IDS.map((id) => (isEnabled(id) ? 1 : 0)).join(""),
  );
  const bar = useRef<HTMLDivElement>(null);
  /** Quem tinha o foco antes do menu: recebe-o de volta ao fechar. */
  const restore = useRef<HTMLElement | null>(null);
  /** Alt pressionado sem outra tecla depois. */
  const armed = useRef(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const show = (i: number) => {
    if (open === null && !bar.current?.contains(document.activeElement)) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOpen((i + MENUS.length) % MENUS.length);
    setQuery("");
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
  // Alt+clique (girar à direita), Alt+roda e Alt+arraste não são "Alt sozinho".
  const disarm = () => (armed.current = false);
  useWindowEvent("blur", disarm);
  useWindowEvent("pointerdown", disarm);
  useWindowEvent("wheel", disarm);

  // Clique fora fecha (o foco fica onde o usuário clicou).
  useWindowEvent("mousedown", (e) => {
    disarm();
    if (open !== null && !bar.current?.contains(e.target as Node)) close(false);
  });

  const run = (id: CommandId) => {
    close();
    runCommand(id);
  };

  useWindowEvent(HELP_SEARCH_EVENT, () => {
    if (open === HELP) search.current?.focus();
    else show(HELP);
  });

  // Com o Pesquisar registrado, o item vira o campo e os resultados entram no topo do menu Ajuda.
  const hits = searchMenus(query, MENUS, t);
  const helpItems = (items: MenuItem[]): ListItem[] => {
    const rest = items.filter((it) => !("command" in it && it.command === "help.search"));
    if (rest[0] && "separator" in rest[0]) rest.shift();
    if (!query.trim()) return rest;
    const found: ListItem[] = hits.length
      ? hits.map((h) => ({ text: h.label, hint: h.path.join(" ▸ "), run: () => runCommand(h.command), disabled: !isEnabled(h.command) }))
      : [{ text: t("helpSearch.noResults"), run: () => {}, disabled: true }];
    return [...found, { separator: true }, ...rest];
  };
  // Janelas abertas, no fim do menu Janela.
  const windows = useTabs((s) => s.windows);
  const windowItems = (items: MenuItem[]): ListItem[] => {
    if (!windows.length) return items;
    const list = windows.map((w) => ({
      text: w.title, checked: w.label === windowLabel(), run: () => void ipc.focusWindow(w.label).catch(notifyError),
    }));
    return [...items, { separator: true }, ...list];
  };
  const searching = open === HELP && isEnabled("help.search");

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
              items={searching && i === HELP ? helpItems(m.items) : i === WINDOW ? windowItems(m.items) : m.items}
              header={
                searching && i === HELP ? (
                  <HelpSearch
                    value={query}
                    onChange={setQuery}
                    onEnter={() => {
                      const h = hits.find((x) => isEnabled(x.command));
                      if (h) run(h.command);
                    }}
                    onCloseAll={close}
                    onSwitch={(dir) => show(i + dir)}
                    inputRef={search}
                  />
                ) : undefined
              }
              level={0}
              autoFocus={!(searching && i === HELP)}
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
