// Abrir arquivos pedidos pelo usuário, sem abrir de novo o que já está em outra janela.
import * as ipc from "../ipc/commands";
import type { DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { hasOtherWindows } from "./store";

/** Arquivo já aberto em outra janela: ela vem para a frente; os demais abrem nesta. */
export async function openHere(paths: string[]): Promise<DocInfo[]> {
  const rest = hasOtherWindows() ? await ipc.focusOpenPaths(paths) : paths;
  return rest.length ? useDocs.getState().open(rest) : [];
}
