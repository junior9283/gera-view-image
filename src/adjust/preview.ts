// Estado da prévia de Ajustar Cor: o painel diz o ajuste, e a camada do visor o mostra na imagem.
import { create } from "zustand";
import type { ColorAdjust, DocId } from "../ipc/types";
import { useDocs } from "../store/docs";

export interface AdjustPreview {
  docId: DocId;
  adjust: ColorAdjust;
  /** OK aplicando: revisão da imagem ainda sem o ajuste. A prévia fica na tela, sem novos pedidos. */
  frozenRev: number | null;
}

interface State {
  cur: AdjustPreview | null;
  /** A última prévia falhou (o painel avisa). */
  failed: boolean;
}

export const useAdjustPreview = create<State>(() => ({ cur: null, failed: false }));
const { getState: get, setState: set } = useAdjustPreview;

const revOf = (id: DocId) => useDocs.getState().docs.find((d) => d.id === id)?.rev ?? null;

export const showPreview = (docId: DocId, adjust: ColorAdjust) => set({ cur: { docId, adjust, frozenRev: null }, failed: false });

export const clearPreview = () => set({ cur: null, failed: false });

/** Para de acompanhar o painel enquanto o ajuste é aplicado. */
export function freezePreview(docId: DocId): void {
  const { cur } = get();
  if (cur?.docId === docId) set({ cur: { ...cur, frozenRev: revOf(docId) } });
}

/**
 * O painel fechou: some, ou espera o visor desenhar a imagem já ajustada (ou falhar), sem prazo: uma
 * imagem enorme demora, e sumir antes mostraria a original por um instante. A camada do visor limpa;
 * aqui só o documento fechado (não há mais o que desenhar).
 */
export function endPreview(docId: DocId): void {
  const { cur } = get();
  if (cur?.docId !== docId) return;
  const rev = revOf(docId);
  if (cur.frozenRev === null || rev === null || rev <= cur.frozenRev) return clearPreview();
  const off = useDocs.subscribe((s) => {
    if (get().cur !== cur) return off();
    if (!s.docs.some((d) => d.id === docId)) {
      off();
      clearPreview();
    }
  });
}
