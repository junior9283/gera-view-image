import { create } from "zustand";
import type { Mask } from "../ipc/types";
import type { SelectionTool } from "../select/tools";

/** Fatia de seleção do estado de UI (a Task 5 cria `ui.ts`; esta fica à parte para o merge). */
interface SelectionState {
  /** Máscara em coordenadas da imagem; `null` = sem seleção. */
  selection: Mask | null;
  /** Ferramenta ativa; `null` = nenhuma ferramenta de seleção (a camada só desenha). */
  selectionTool: SelectionTool | null;
  setSelection: (m: Mask | null) => void;
  setSelectionTool: (t: SelectionTool | null) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  selection: null,
  selectionTool: null,
  setSelection: (selection) => set({ selection }),
  setSelectionTool: (selectionTool) => set({ selectionTool }),
}));
