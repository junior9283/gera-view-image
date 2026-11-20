import { useSyncExternalStore } from "react";
import { subscribeHistory } from "../edit/history";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { isEnabled, subscribeCommands, type CommandId } from "./commands";

/** A habilitação depende do registro, dos stores de documento, seleção e interface e do histórico. */
export function subscribeEnabled(l: () => void): () => void {
  const offs = [subscribeCommands(l), useDocs.subscribe(l), useSelection.subscribe(l), useUi.subscribe(l), subscribeHistory(l)];
  return () => offs.forEach((off) => off());
}

/** Se o comando está habilitado agora (re-renderiza quando muda). */
export const useEnabled = (id: CommandId): boolean => useSyncExternalStore(subscribeEnabled, () => isEnabled(id));
