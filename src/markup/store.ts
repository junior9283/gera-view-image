import { create } from "zustand";
import type { DocId } from "../ipc/types";
import { DEFAULT_FONT, DEFAULT_STYLE, mergeStyle, type Annotation, type Style, type StylePatch } from "./model";

/** Ferramentas da barra de Marcação. As formas criam a anotação do mesmo tipo. */
export type ShapeTool =
  | "line" | "arrow" | "rect" | "roundRect" | "oval" | "bubble" | "star" | "polygon" | "loupe" | "highlight" | "highlightOval";
export type Tool = "select" | "sketch" | "draw" | "text" | ShapeTool;
export type BarMenu = "shapes" | "signature" | "lineStyle" | "stroke" | "fill" | "textStyle";

const EMPTY: Annotation[] = [];

interface MarkupState {
  /** Barra de Marcação visível (a camada só recebe o ponteiro com ela ativa). */
  visible: boolean;
  tool: Tool;
  /** Estilo usado nas próximas anotações. */
  style: Style;
  /** Anotações por documento (a pilha de desfazer guarda snapshots destes arrays). */
  docs: Record<DocId, Annotation[]>;
  selected: Record<DocId, string[]>;
  /** Texto em edição na camada. */
  editing: string | null;
  /** Menu/painel aberto na barra (ex.: `shapes`, `signature`). */
  menu: BarMenu | null;
  setVisible: (v: boolean) => void;
  toggle: () => void;
  setTool: (t: Tool) => void;
  setStyle: (patch: StylePatch) => void;
  /** Troca as anotações sem passar pelo histórico (arrasto ao vivo, desfazer). */
  setItems: (id: DocId, items: Annotation[]) => void;
  select: (id: DocId, ids: string[]) => void;
  setEditing: (id: string | null) => void;
  setMenu: (m: BarMenu | null) => void;
  /** Esquece o documento (fechado). */
  drop: (id: DocId) => void;
}

const INITIAL = {
  visible: false,
  tool: "select" as Tool,
  style: { ...DEFAULT_STYLE, font: { ...DEFAULT_FONT } },
  docs: {} as Record<DocId, Annotation[]>,
  selected: {} as Record<DocId, string[]>,
  editing: null as string | null,
  menu: null as BarMenu | null,
};

export const useMarkup = create<MarkupState>((set) => ({
  ...INITIAL,
  setVisible: (visible) => set(visible ? { visible } : { visible, editing: null, menu: null }),
  toggle: () => set((s) => (s.visible ? { visible: false, editing: null, menu: null } : { visible: true })),
  setTool: (tool) => set({ tool }),
  setStyle: (patch) => set((s) => ({ style: mergeStyle(s.style, patch) })),
  setItems: (id, items) =>
    set((s) => {
      const keep = new Set(items.map((a) => a.id));
      const sel = s.selected[id]?.filter((x) => keep.has(x));
      return { docs: { ...s.docs, [id]: items }, selected: sel ? { ...s.selected, [id]: sel } : s.selected };
    }),
  select: (id, ids) => set((s) => ({ selected: { ...s.selected, [id]: ids } })),
  setEditing: (editing) => set({ editing }),
  setMenu: (menu) => set({ menu }),
  drop: (id) =>
    set((s) => {
      const docs = { ...s.docs };
      const selected = { ...s.selected };
      delete docs[id];
      delete selected[id];
      return { docs, selected };
    }),
}));

export const getItems = (id: DocId): Annotation[] => useMarkup.getState().docs[id] ?? EMPTY;
export const getSelected = (id: DocId): string[] => useMarkup.getState().selected[id] ?? [];
export const useItems = (id: DocId | null) => useMarkup((s) => (id === null ? EMPTY : (s.docs[id] ?? EMPTY)));

/** Mostra/oculta a barra de Marcação (a Toolbar e o Ctrl+Shift+M disparam `gvi:toggle-markup`). */
export const toggleMarkupBar = () => useMarkup.getState().toggle();

export const TOGGLE_MARKUP_EVENT = "gvi:toggle-markup";

/** Só para testes. */
export function resetMarkupForTests(): void {
  useMarkup.setState(INITIAL);
}
