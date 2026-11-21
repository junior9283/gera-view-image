// Menu de contexto da imagem (botão direito no Viewport), com os itens do Pré-Visualização.
// Usa os comandos do registro: o que outro lote ainda não registrou (Copiar Objeto, Texto ao
// Vivo, Compartilhar) aparece desabilitado e habilita sozinho quando ele registrar.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MenuList } from "../chrome/MenuBar";
import type { MenuItem } from "../chrome/menus";
import { runCommand, type CommandId } from "../shortcuts/commands";

const SEP: MenuItem = { separator: true };
const cmd = (command: CommandId): MenuItem => ({ label: `menu.${command}`, command });

export const IMAGE_MENU: MenuItem[] = [
  cmd("edit.cut"),
  cmd("edit.copy"),
  cmd("edit.paste"),
  SEP,
  cmd("tools.copySubject"),
  cmd("tools.copyAllText"),
  SEP,
  cmd("tools.rotateLeft"),
  cmd("tools.rotateRight"),
  SEP,
  { label: "menu.file.share", submenu: [cmd("file.shareEmail"), cmd("file.shareDevice")] },
  cmd("file.openWith"),
];

/** Ouve o botão direito na área do Viewport (montado no slot `viewport-overlay`). */
export function ImageContextMenu() {
  const { t } = useTranslation();
  const anchor = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const viewport = anchor.current?.closest<HTMLElement>(".viewport");
    if (!viewport) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    };
    viewport.addEventListener("contextmenu", onContext);
    return () => viewport.removeEventListener("contextmenu", onContext);
  }, []);

  // Perto da borda da janela, o menu abre para o outro lado (como os menus do sistema).
  useLayoutEffect(() => {
    const el = box.current;
    const list = el?.firstElementChild?.getBoundingClientRect();
    if (!el || !at || !list) return;
    if (list.right > window.innerWidth) el.style.left = `${Math.max(0, at.x - list.width)}px`;
    if (list.bottom > window.innerHeight) el.style.top = `${Math.max(0, at.y - list.height - 4)}px`;
  }, [at]);

  const close = () => setAt(null);
  return (
    <div ref={anchor} hidden>
      {at &&
        createPortal(
          <>
            <div
              className="wm-backdrop"
              data-testid="context-backdrop"
              onMouseDown={close}
              onContextMenu={(e) => {
                e.preventDefault();
                close();
              }}
            />
            <div ref={box} className="image-context" style={{ position: "fixed", left: at.x, top: at.y, zIndex: 100 }}>
              <MenuList
                label={t("select.contextMenu")}
                items={IMAGE_MENU}
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
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
