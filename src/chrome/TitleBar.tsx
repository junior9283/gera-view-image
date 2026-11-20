import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowButtons, type WindowAction } from "./WindowButtons";
import { enableNativeDecorations, useApplyNativeDecorations, useCompositingProbe, useNativeDecorations } from "./nativeDecorations";
import { useWindowTheme } from "./windowTheme";
import "./chrome.css";
import { subscribe } from "../lib/events";

interface Props {
  /** Nome do arquivo, mostrado ao centro. */
  title: string;
  /** Slot da Tarefa 6: menus e barra de ferramentas ficam entre o título e os botões. */
  children?: ReactNode;
  /** `prefs.nativeDecorations`: usa a decoração do sistema e esconde os botões próprios. */
  nativeDecorations?: boolean;
}

export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    const win = getCurrentWindow();
    const sync = () =>
      win
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => {});
    sync();
    const off = subscribe(win.onResized(sync));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return maximized;
}

export function TitleBar({ title, children, nativeDecorations: override = false }: Props) {
  const { t } = useTranslation();
  const nativeDecorations = useNativeDecorations(override);
  useCompositingProbe();
  useApplyNativeDecorations(nativeDecorations);
  const theme = useWindowTheme();
  const maximized = useMaximized();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const run = useCallback((a: WindowAction) => {
    const win = getCurrentWindow();
    if (a === "minimize") void win.minimize();
    else if (a === "close") void win.close();
    else void win.toggleMaximize();
    setMenu(null);
  }, []);

  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const buttons = (side: "left" | "right") =>
    nativeDecorations ? null : <WindowButtons side={side} theme={theme} maximized={maximized} onAction={run} />;

  // Duplo clique para maximizar: o drag.js do Tauri já trata (e.detail === 2) quando o alvo tem
  // data-tauri-drag-region. Por isso não há onDoubleClick aqui, e só o header e o título levam o
  // atributo; botões e o slot de ferramentas (children) ficam fora da região de arrasto.
  return (
    <header className="titlebar" data-tauri-drag-region onContextMenu={onContext}>
      {buttons("left")}
      <div className="titlebar-title" data-tauri-drag-region>
        {title}
      </div>
      {children && <div className="titlebar-slot">{children}</div>}
      {buttons("right")}
      {menu && (
        <>
          <div
            className="wm-backdrop"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <ul className="wm-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <li role="menuitem" onClick={() => run("minimize")}>{t("window.minimize")}</li>
            <li role="menuitem" onClick={() => run("maximize")}>{t(maximized ? "window.restore" : "window.maximize")}</li>
            <li role="menuitem" onClick={() => run("close")}>{t("window.close")}</li>
          </ul>
        </>
      )}
    </header>
  );
}

type Dir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";
const EDGES: Dir[] = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"];

/** Moldura da janela: cantos de 8 px e bordas de 6 px para redimensionar (janela sem decoração). */
export function WindowFrame({ children, nativeDecorations: override = false }: { children: ReactNode; nativeDecorations?: boolean }) {
  const nativeDecorations = useNativeDecorations(override);
  const maximized = useMaximized();
  const flat = maximized || nativeDecorations;
  return (
    <div className={`window-frame${flat ? " flat" : ""}`}>
      {children}
      {!flat &&
        EDGES.map((d) => (
          <div
            key={d}
            className={`resize-edge edge-${d}`}
            onMouseDown={(e) => {
              if (e.button === 0) getCurrentWindow().startResizeDragging(d).catch(enableNativeDecorations);
            }}
          />
        ))}
    </div>
  );
}
