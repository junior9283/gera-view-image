// Estado das abas desta janela. Uma aba = um documento aberto na janela (`useDocs`).
import { create } from "zustand";
import type { WindowEntry } from "../ipc/types";

/** Por que a janela está bloqueada; `quitting`: já concordou em sair e espera as outras. */
export type Veil = "moving" | "saving" | "closing" | "quitting";

export interface Question {
  title: string;
  body: string;
  ok: string;
  cancel: string;
}

interface TabsState {
  /** Janelas abertas do app (menu Janela). */
  windows: WindowEntry[];
  /** Mostrar Todas as Abas. */
  overview: boolean;
  /** Véu que bloqueia a janela (o último posto por `putVeil`). */
  veil: Veil | null;
  /** Pergunta de sim ou não (`ask`). */
  question: Question | null;
}

const INITIAL: TabsState = { windows: [], overview: false, veil: null, question: null };

export const useTabs = create<TabsState>(() => INITIAL);

let veils: { kind: Veil }[] = [];
const showVeil = () => useTabs.setState({ veil: veils.length ? veils[veils.length - 1].kind : null });

/** Bloqueia a janela. Só quem pôs tira: a função devolvida remove este véu, e os outros continuam. */
export function putVeil(kind: Veil): () => void {
  const mine = { kind };
  veils = [...veils, mine];
  showVeil();
  return () => {
    veils = veils.filter((v) => v !== mine);
    showVeil();
  };
}

let reply: ((ok: boolean) => void) | null = null;

/** Responde à pergunta em exibição. */
export function answerQuestion(ok: boolean): void {
  const r = reply;
  reply = null;
  useTabs.setState({ question: null });
  r?.(ok);
}

/**
 * Pergunta de sim ou não, com Cancelar por padrão. Uma pergunta nova cancela a anterior; `until`, se
 * terminar em verdadeiro antes da resposta, vale como sim.
 */
export function ask(question: Question, until?: Promise<boolean>): Promise<boolean> {
  answerQuestion(false);
  return new Promise((resolve) => {
    reply = resolve;
    useTabs.setState({ question });
    void until?.then((done) => done && reply === resolve && answerQuestion(true));
  });
}

export const showOverview = (overview: boolean) => useTabs.setState({ overview });

export const setWindows = (windows: WindowEntry[]) => useTabs.setState({ windows });

export const hasOtherWindows = () => useTabs.getState().windows.length > 1;

/** Só para testes. */
export function resetTabsForTests(): void {
  answerQuestion(false);
  veils = [];
  useTabs.setState(INITIAL);
}
