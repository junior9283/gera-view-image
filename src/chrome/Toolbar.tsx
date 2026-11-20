import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { runCommand, type CommandId } from "../shortcuts/commands";
import { useEnabled } from "../shortcuts/useEnabled";
import { InspectorIcon, MarkupIcon, RotateIcon, ShareIcon, SidebarIcon, ZoomInIcon, ZoomOutIcon } from "./icons";
import { MenuList } from "./MenuBar";
import type { MenuItem } from "./menus";

function ToolButton({ command, label, children, onClick }: { command: CommandId; label: string; children: ReactNode; onClick?: (alt: boolean) => void }) {
  const on = useEnabled(command);
  return (
    <button
      type="button"
      className="tool-button"
      aria-label={label}
      title={label}
      disabled={!on}
      onClick={(e) => (onClick ? onClick(e.altKey) : runCommand(command))}
    >
      {children}
    </button>
  );
}

const SHARE: MenuItem[] = [
  { label: "menu.file.export", command: "file.export" },
  { label: "menu.edit.copy", command: "edit.copy" },
  { label: "menu.file.openWith", command: "file.openWith" },
];

function ShareButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
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
        onClick={() => setOpen(!open)}
      >
        <ShareIcon />
      </button>
      {open && (
        <MenuList
          label={t("toolbar.share")}
          items={SHARE}
          level={0}
          autoFocus
          onRun={(id) => {
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

/** Barra de ferramentas à direita da barra de título (como no Preview). */
export function Toolbar() {
  const { t } = useTranslation();
  return (
    <div className="toolbar" role="toolbar" aria-label={t("toolbar.label")}>
      <ToolButton command="view.thumbnails" label={t("toolbar.sidebar")}>
        <SidebarIcon />
      </ToolButton>
      <div className="tool-group">
        <ToolButton command="view.zoomOut" label={t("toolbar.zoomOut")}>
          <ZoomOutIcon />
        </ToolButton>
        <ToolButton command="view.zoomIn" label={t("toolbar.zoomIn")}>
          <ZoomInIcon />
        </ToolButton>
      </div>
      <ShareButton />
      <ToolButton command="view.markupBar" label={t("toolbar.markup")}>
        <MarkupIcon />
      </ToolButton>
      <ToolButton
        command="tools.rotateLeft"
        label={t("toolbar.rotate")}
        onClick={(alt) => runCommand(alt ? "tools.rotateRight" : "tools.rotateLeft")}
      >
        <RotateIcon />
      </ToolButton>
      <ToolButton command="tools.inspector" label={t("toolbar.inspector")}>
        <InspectorIcon />
      </ToolButton>
    </div>
  );
}
