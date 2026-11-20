import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowButtons, type WindowAction } from "./WindowButtons";
import { useWindowTheme } from "./windowTheme";
import "./chrome.css";

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
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const sync = () =>
      win
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => {});
    sync();
    win
      .onResized(sync)
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return maximized;
}

export function TitleBar({ title, children, nativeDecorations = false }: Props) {
  const theme = useWindowTheme();
  const maximized = useMaximized();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (nativeDecorations) getCurrentWindow().setDecorations(true).catch(() => {});
  }, [nativeDecorations]);

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

  return (
    <header className="titlebar" data-tauri-drag-region onDoubleClick={() => run("maximize")} onContextMenu={onContext}>
      {buttons("left")}
      <div className="titlebar-title" data-tauri-drag-region>
        {title}
      </div>
      {children}
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
            <li role="menuitem" onClick={() => run("minimize")}>Minimizar</li>
            <li role="menuitem" onClick={() => run("maximize")}>{maximized ? "Restaurar" : "Maximizar"}</li>
            <li role="menuitem" onClick={() => run("close")}>Fechar</li>
          </ul>
        </>
      )}
    </header>
  );
}

type Dir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";
const EDGES: Dir[] = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"];

/** Moldura da janela: cantos de 8 px e bordas de 6 px para redimensionar (janela sem decoração). */
export function WindowFrame({ children, nativeDecorations = false }: { children: ReactNode; nativeDecorations?: boolean }) {
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
              if (e.button === 0) void getCurrentWindow().startResizeDragging(d);
            }}
          />
        ))}
    </div>
  );
}
