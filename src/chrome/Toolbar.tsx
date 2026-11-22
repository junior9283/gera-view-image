import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import type { AppEntry } from "../ipc/types";
import { useWindowEvent } from "../lib/events";
import { runCommand, type CommandId } from "../shortcuts/commands";
import { useEnabled } from "../shortcuts/useEnabled";
import { usePrefs, type Prefs } from "../store/prefs";
import { ShareIcon } from "./icons";
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
  const label = t(def.hint);
  // Girar: Alt+clique gira à direita (como no Preview).
  const run = (alt: boolean) => runCommand(def.command === "tools.rotateLeft" && alt ? "tools.rotateRight" : def.command);
  return (
    <button type="button" className="tool-button" aria-label={label} title={label} disabled={!on} onClick={(e) => run(e.altKey)}>
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

function ShareButton({ mode, text }: { mode: Mode; text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useWindowEvent("mousedown", (e) => {
    if (open && !box.current?.contains(e.target as Node)) setOpen(false);
  });

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    setApps(null);
    const d = sharedDoc();
    if (d) ipc.openWithApps(d.id).then(setApps, () => setApps([]));
  };

  const openApp = (a: AppEntry) => {
    const d = sharedDoc();
    if (d) ipc.openWithApp(d.id, a.id).catch(notifyError);
  };

  return (
    <div ref={box} className="tool-share">
      <button
        ref={button}
        type="button"
        className="tool-button"
        aria-label={t("toolbar.share")}
        title={t("toolbar.share")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Face mode={mode} icon={<ShareIcon />} text={text} />
      </button>
      {open && (
        <MenuList
          label={t("toolbar.share")}
          items={shareItems(apps, openApp)}
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

/** Um item da barra: botão, grupo (Zoom) ou o menu Compartilhar. */
function ToolbarEntry({ item, mode }: { item: ToolbarItemDef; mode: Mode }) {
  const { t } = useTranslation();
  const text = t(item.label);
  if (item.share) return <ShareButton mode={mode} text={text} />;
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
