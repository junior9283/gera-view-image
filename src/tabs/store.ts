// Estado das abas desta janela. Uma aba = um documento aberto na janela (`useDocs`).
import { create } from "zustand";
import type { WindowEntry } from "../ipc/types";

interface TabsState {
  /** Janelas abertas do app (menu Janela). */
  windows: WindowEntry[];
  /** Mostrar Todas as Abas. */
  overview: boolean;
  /** Janela bloqueada: movendo documentos ou fechando. */
  veil: "moving" | "closing" | null;
}

const INITIAL: TabsState = { windows: [], overview: false, veil: null };

export const useTabs = create<TabsState>(() => INITIAL);

export const setVeil = (veil: TabsState["veil"]) => useTabs.setState({ veil });
export const showOverview = (overview: boolean) => useTabs.setState({ overview });

export const setWindows = (windows: WindowEntry[]) => useTabs.setState({ windows });

export const hasOtherWindows = () => useTabs.getState().windows.length > 1;

/** Só para testes. */
export function resetTabsForTests(): void {
  useTabs.setState(INITIAL);
}
