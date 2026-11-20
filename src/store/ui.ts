import { create } from "zustand";
import type { Size, ViewState } from "../viewer/zoom";

export type SidebarMode = "hidden" | "thumbs" | "contact";

export const CONTACT_MIN = 64;
export const CONTACT_MAX = 320;

interface UiState {
  sidebar: SidebarMode;
  fullscreen: boolean;
  slideshow: boolean;
  /** Visualização do documento ativo; `null` até o Viewport medir a área. */
  view: ViewState | null;
  /** Tamanho da área do Viewport em px CSS. */
  viewSize: Size;
  /** Página escolhida na barra lateral (TIFF/GIF); `null` = padrão (GIF anima). */
  page: number | null;
  /** Lado das miniaturas da folha de contato, em px. */
  contactSize: number;
  setSidebar: (m: SidebarMode) => void;
  setView: (v: ViewState | null) => void;
  setViewSize: (s: Size) => void;
  setPage: (p: number | null) => void;
  setContactSize: (px: number) => void;
}

const INITIAL = {
  sidebar: "hidden" as SidebarMode,
  fullscreen: false,
  slideshow: false,
  view: null,
  viewSize: { w: 0, h: 0 },
  page: null,
  contactSize: 160,
};

export const useUi = create<UiState>((set) => ({
  ...INITIAL,
  setSidebar: (sidebar) => set({ sidebar }),
  setView: (view) => set({ view }),
  setViewSize: (viewSize) => set({ viewSize }),
  setPage: (page) => set({ page }),
  setContactSize: (px) => set({ contactSize: Math.round(Math.min(CONTACT_MAX, Math.max(CONTACT_MIN, px))) }),
}));

/** Só para testes. */
export function resetUiForTests(): void {
  useUi.setState(INITIAL);
}
