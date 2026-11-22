import { useSyncExternalStore } from "react";
import { subscribeHistory } from "../edit/history";
import { subscribeDirty } from "../file/dirty";
import { useMarkup } from "../markup/store";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { isEnabled, subscribeCommands, type CommandId } from "./commands";

/** A habilitação depende do registro, dos stores de documento, seleção, marcação e interface, do histórico e do estado não salvo. */
export function subscribeEnabled(l: () => void): () => void {
  const offs = [subscribeCommands(l), useDocs.subscribe(l), useSelection.subscribe(l), useMarkup.subscribe(l), useUi.subscribe(l), subscribeHistory(l), subscribeDirty(l)];
  return () => offs.forEach((off) => off());
}

/** Se o comando está habilitado agora (re-renderiza quando muda). */
export const useEnabled = (id: CommandId): boolean => useSyncExternalStore(subscribeEnabled, () => isEnabled(id));
