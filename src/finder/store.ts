// Estado da interface do Lote 5: popover do título, navegador de versões e confirmação do Lixo.
import { create } from "zustand";
import type { DocId } from "../ipc/types";
import { useTabs } from "../tabs/store";

/** `text` e `ok` são chaves de i18n (`text` recebe `{ name }`); `details`, itens já traduzidos. */
interface Confirm {
  id: DocId;
  name: string;
  text: string;
  ok: string;
  details: string[];
  /** Perguntado com a janela sob o véu (ex.: perdas do Salvar ao fechar): fica acima dele. */
  aboveVeil: boolean;
  resolve: (ok: boolean) => void;
}

interface FinderUi {
  /** Documento cujo popover do título está aberto. */
  popover: DocId | null;
  /** Abrir o popover com o foco nas etiquetas (Arquivo › Etiquetas…). */
  focusTags: boolean;
  /** Documento no navegador de versões. */
  versions: DocId | null;
  /** Pedido de confirmação antes de descartar algo (Lixo, Restaurar versão, gravar com perdas). */
  confirm: Confirm | null;
  /** Último estado de bloqueio conhecido de cada documento. */
  locked: Record<DocId, boolean>;
}

export const useFinderUi = create<FinderUi>(() => ({
  popover: null, focusTags: false, versions: null, confirm: null, locked: {},
}));

export const openPopover = (id: DocId, focusTags = false) => useFinderUi.setState({ popover: id, focusTags });
export const closePopover = () => useFinderUi.setState({ popover: null, focusTags: false });
export const openVersions = (id: DocId) => useFinderUi.setState({ versions: id, popover: null });
export const closeVersions = () => useFinderUi.setState({ versions: null });
export const setLockedState = (id: DocId, locked: boolean) =>
  useFinderUi.setState((s) => ({ locked: { ...s.locked, [id]: locked } }));

/**
 * Pergunta (diálogo do `FinderHost`) se pode descartar as alterações (ou os `details`); `true` = pode.
 * Feita com a janela sob o véu, é a operação em curso que pergunta: o diálogo fica acima do véu. Uma
 * confirmação aberta antes continua embaixo de um véu posto depois.
 */
export function askDiscard(id: DocId, name: string, text: string, ok: string, details: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    useFinderUi.getState().confirm?.resolve(false);
    const aboveVeil = useTabs.getState().veil !== null;
    useFinderUi.setState({ confirm: { id, name, text, ok, details, aboveVeil, resolve } });
  });
}

export function answerConfirm(ok: boolean): void {
  const req = useFinderUi.getState().confirm;
  useFinderUi.setState({ confirm: null });
  req?.resolve(ok);
}

/** Só para testes. */
export function resetFinderUiForTests(): void {
  useFinderUi.setState({ popover: null, focusTags: false, versions: null, confirm: null, locked: {} });
}
