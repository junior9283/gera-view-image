// Estado da interface do Lote 5: popover do título, navegador de versões e confirmação do Lixo.
import { create } from "zustand";
import type { DocId } from "../ipc/types";

interface FinderUi {
  /** Documento cujo popover do título está aberto. */
  popover: DocId | null;
  /** Abrir o popover com o foco nas etiquetas (Arquivo › Etiquetas…). */
  focusTags: boolean;
  /** Documento no navegador de versões. */
  versions: DocId | null;
  /** Pedido de confirmação para mandar ao Lixo um documento com alterações. */
  confirmTrash: { id: DocId; name: string; resolve: (ok: boolean) => void } | null;
  /** Último estado de bloqueio conhecido de cada documento. */
  locked: Record<DocId, boolean>;
}

export const useFinderUi = create<FinderUi>(() => ({
  popover: null, focusTags: false, versions: null, confirmTrash: null, locked: {},
}));

export const openPopover = (id: DocId, focusTags = false) => useFinderUi.setState({ popover: id, focusTags });
export const closePopover = () => useFinderUi.setState({ popover: null, focusTags: false });
export const openVersions = (id: DocId) => useFinderUi.setState({ versions: id, popover: null });
export const closeVersions = () => useFinderUi.setState({ versions: null });
export const setLockedState = (id: DocId, locked: boolean) =>
  useFinderUi.setState((s) => ({ locked: { ...s.locked, [id]: locked } }));

/** Pergunta (diálogo do `FinderHost`) se pode descartar as alterações; `true` = pode. */
export function askTrash(id: DocId, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    useFinderUi.getState().confirmTrash?.resolve(false);
    useFinderUi.setState({ confirmTrash: { id, name, resolve } });
  });
}

export function answerTrash(ok: boolean): void {
  const req = useFinderUi.getState().confirmTrash;
  useFinderUi.setState({ confirmTrash: null });
  req?.resolve(ok);
}

/** Só para testes. */
export function resetFinderUiForTests(): void {
  useFinderUi.setState({ popover: null, focusTags: false, versions: null, confirmTrash: null, locked: {} });
}
