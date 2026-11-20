import type { CSSProperties } from "react";
import type { WinButton, WindowTheme } from "./windowTheme";
import "./buttonStyles/breeze.css";
import "./buttonStyles/adwaita.css";
import "./buttonStyles/elementary.css";
import "./buttonStyles/generic.css";

export type WindowAction = "minimize" | "maximize" | "restore" | "close";

interface Props {
  side: "left" | "right";
  theme: WindowTheme;
  maximized: boolean;
  onAction: (action: WindowAction) => void;
}

const LABEL: Record<WindowAction, string> = {
  minimize: "Minimizar",
  maximize: "Maximizar",
  restore: "Restaurar",
  close: "Fechar",
};

const PATHS: Record<WindowAction, string> = {
  minimize: "M4 8h8",
  maximize: "M4.5 4.5h7v7h-7z",
  restore: "M6 4.5h5.5V10M4.5 6H10v5.5H4.5z",
  close: "M4.5 4.5l7 7m0-7l-7 7",
};

function Glyph({ name, icons }: { name: WindowAction; icons: WindowTheme["icons"] }) {
  const src = icons?.[name];
  if (src) return <img className="wb-img" src={src} alt="" draggable={false} />;
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function cssVars(theme: WindowTheme): CSSProperties {
  const v: Record<string, string> = {};
  if (theme.accent) v["--wm-accent"] = theme.accent;
  if (theme.colors) {
    v["--wm-active-bg"] = theme.colors.activeBg;
    v["--wm-active-fg"] = theme.colors.activeFg;
    v["--wm-inactive-bg"] = theme.colors.inactiveBg;
    v["--wm-inactive-fg"] = theme.colors.inactiveFg;
  }
  return v as CSSProperties;
}

/** Os botões de um lado da barra, na ordem do sistema; botão ausente no layout não é desenhado. */
export function WindowButtons({ side, theme, maximized, onAction }: Props) {
  const list: WinButton[] = theme.layout[side];
  if (list.length === 0) return null;
  return (
    <div
      className={`window-buttons style-${theme.style}`}
      data-side={side}
      data-dark={theme.dark}
      style={cssVars(theme)}
    >
      {list.map((b) => {
        const action: WindowAction = b === "maximize" && maximized ? "restore" : b;
        return (
          <button
            key={b}
            type="button"
            className="wb-btn"
            data-button={b}
            data-action={action}
            aria-label={LABEL[action]}
            title={LABEL[action]}
            onClick={() => onAction(action)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Glyph name={action} icons={theme.icons} />
          </button>
        );
      })}
    </div>
  );
}
