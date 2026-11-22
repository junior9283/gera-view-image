// Abrir arquivos pedidos pelo usuário, sem abrir de novo o que já está em outra janela.
import * as ipc from "../ipc/commands";
import type { DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { hasOtherWindows } from "./store";

/** Os caminhos que não estão abertos em outra janela, sem mexer no foco (navegação pela pasta). */
export const notElsewhere = async (paths: string[]): Promise<string[]> =>
  hasOtherWindows() ? ipc.focusOpenPaths(paths, false) : paths;

/** Arquivo já aberto em outra janela: ela vem para a frente; os demais abrem nesta. */
export async function openHere(paths: string[]): Promise<DocInfo[]> {
  const rest = hasOtherWindows() ? await ipc.focusOpenPaths(paths, true) : paths;
  return rest.length ? useDocs.getState().open(rest) : [];
}
