import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import type { AppEntry } from "../ipc/types";
import { useMarkup } from "../markup/store";
import type { SelectionTool } from "../select/tools";
import { useWindowEvent } from "../lib/events";
import { runCommand, type CommandId } from "../shortcuts/commands";
import { commandState, subscribeCommandState } from "../shortcuts/commandState";
import { useEnabled } from "../shortcuts/useEnabled";
import { useSelection } from "../store/selection";
import { usePrefs, type Prefs } from "../store/prefs";
import { MenuList, type ListItem } from "./MenuBar";
import { notifyError } from "./notify";
import { hasDeviceShare, sharedDoc } from "./share";
import { resolveToolbar, toolbarItem, type ToolbarButtonDef, type ToolbarItemDef } from "./toolbarItems";

type Mode = Prefs["toolbarMode"];

/** Ícone, ícone e texto, ou só texto (Personalizar › Mostrar). */
function Face({ mode, icon, text }: { mode: Mode; icon: ReactNode; text: string }) {
  return (
    <>
      {mode !== "text" && icon}
      {mode !== "icon" && <span className="tool-text">{text}</span>}
    </>
  );
}

function ToolButton({ def, mode, text }: { def: ToolbarButtonDef; mode: Mode; text: string }) {
  const { t } = useTranslation();
  const on = useEnabled(def.command);
  const pressed = useSyncExternalStore(subscribeCommandState, () => commandState(def.command).on);
  const label = t(def.hint);
  // Girar: Alt+clique gira à direita (como no Preview).
  const run = (alt: boolean) => runCommand(def.command === "tools.rotateLeft" && alt ? "tools.rotateRight" : def.command);
  return (
    <button type="button" className="tool-button" aria-label={label} title={label} aria-pressed={pressed} disabled={!on} onClick={(e) => run(e.altKey)}>
      <Face mode={mode} icon={<def.Icon />} text={text} />
    </button>
  );
}

const OTHER_APP: ListItem = { label: "toolbar.openWithOther", command: "file.openWith" };

/** Itens do menu Compartilhar: e-mail, KDE Connect (se instalado), copiar, exportar e Abrir com ▸. */
function shareItems(apps: AppEntry[] | null, openApp: (a: AppEntry) => void): ListItem[] {
  const openWith: ListItem[] = apps?.length
    ? [...apps.map((a) => ({ text: a.name, run: () => openApp(a) })), { separator: true }, OTHER_APP]
    : [OTHER_APP];
  return [
    { label: "menu.file.shareEmail", command: "file.shareEmail" },
    ...(hasDeviceShare() ? [{ label: "menu.file.shareDevice", command: "file.shareDevice" } as const] : []),
    { separator: true },
    { label: "menu.edit.copy", command: "edit.copy" },
    { label: "menu.file.export", command: "file.export" },
    { label: "toolbar.openWith", submenu: openWith },
  ];
}

interface MenuButtonProps {
  item: ToolbarItemDef;
  mode: Mode;
  items: ListItem[];
  /** Chamado ao abrir (carregar o que o menu mostra). */
  onOpen?: () => void;
}

/** Botão que abre um menu abaixo dele. */
function MenuButton({ item, mode, items, onOpen }: MenuButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { hint, Icon } = item.buttons[0];

  useWindowEvent("mousedown", (e) => {
    if (open && !box.current?.contains(e.target as Node)) setOpen(false);
  });

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };

  return (
    <div ref={box} className="tool-share">
      <button
        ref={button}
        type="button"
        className="tool-button"
        aria-label={t(hint)}
        title={t(hint)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Face mode={mode} icon={<Icon />} text={t(item.label)} />
      </button>
      {open && (
        <MenuList
          label={t(hint)}
          items={items}
          level={0}
          autoFocus
          onRun={(id: CommandId) => {
            close();
            runCommand(id);
          }}
          onClose={close}
          onCloseAll={close}
          onSwitch={() => {}}
        />
      )}
    </div>
  );
}

function ShareButton({ item, mode }: { item: ToolbarItemDef; mode: Mode }) {
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const load = () => {
    setApps(null);
    const d = sharedDoc();
    if (d) ipc.openWithApps(d.id).then(setApps, () => setApps([]));
  };
  const openApp = (a: AppEntry) => {
    const d = sharedDoc();
    if (d) ipc.openWithApp(d.id, a.id).catch(notifyError);
  };
  return <MenuButton item={item} mode={mode} items={shareItems(apps, openApp)} onOpen={load} />;
}

const SELECTION_TOOLS: SelectionTool[] = ["rect", "ellipse", "lasso", "smartLasso"];

/** Ferramentas de seleção da imagem; escolher a que está ligada desliga. */
function SelectionButton({ item, mode }: { item: ToolbarItemDef; mode: Mode }) {
  const { t } = useTranslation();
  const active = useSelection((s) => s.selectionTool);
  const hasDoc = useEnabled("view.actualSize");
  const pick = (tool: SelectionTool) => {
    // A camada de Marcação larga o ponteiro.
    useMarkup.getState().setTool("select");
    useSelection.getState().setSelectionTool(tool === active ? null : tool);
  };
  const items = SELECTION_TOOLS.map((tool) => ({
    text: t(`markup.selectTool.${tool}`), checked: tool === active, disabled: !hasDoc, run: () => pick(tool),
  }));
  return <MenuButton item={item} mode={mode} items={items} />;
}

/** Um item da barra: botão, grupo (Zoom) ou o menu (Compartilhar, Seleção). */
function ToolbarEntry({ item, mode }: { item: ToolbarItemDef; mode: Mode }) {
  const { t } = useTranslation();
  const text = t(item.label);
  if (item.menu === "share") return <ShareButton item={item} mode={mode} />;
  if (item.menu === "selection") return <SelectionButton item={item} mode={mode} />;
  if (item.buttons.length === 1) return <ToolButton def={item.buttons[0]} mode={mode} text={text} />;
  return (
    <div className="tool-group" role="group" aria-label={text}>
      {item.buttons.map((b) => (
        <ToolButton key={b.command} def={b} mode="icon" text={text} />
      ))}
      {mode !== "icon" && <span className="tool-text tool-group-text">{text}</span>}
    </div>
  );
}

/** Barra de ferramentas à direita da barra de título (como no Preview); some com Ocultar Barra. */
export function Toolbar() {
  const { t } = useTranslation();
  const hidden = usePrefs((p) => p.toolbarHidden);
  const ids = usePrefs((p) => p.toolbarItems);
  const mode = usePrefs((p) => p.toolbarMode);
  if (hidden) return null;
  return (
    <div className={`toolbar toolbar-${mode}`} role="toolbar" aria-label={t("toolbar.label")}>
      {resolveToolbar(ids).map((id) => (
        <ToolbarEntry key={id} item={toolbarItem(id)!} mode={mode} />
      ))}
    </div>
  );
}
