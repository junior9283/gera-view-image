import { useSyncExternalStore } from "react";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { isEnabled, subscribeCommands, type CommandId } from "./commands";

/** A habilitação depende do registro e dos stores de documento, seleção e interface. */
function subscribe(l: () => void): () => void {
  const offs = [subscribeCommands(l), useDocs.subscribe(l), useSelection.subscribe(l), useUi.subscribe(l)];
  return () => offs.forEach((off) => off());
}

/** Se o comando está habilitado agora (re-renderiza quando muda). */
export const useEnabled = (id: CommandId): boolean => useSyncExternalStore(subscribe, () => isEnabled(id));
