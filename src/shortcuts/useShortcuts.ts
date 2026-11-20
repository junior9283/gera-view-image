import { useEffect } from "react";
import { runCommand, type CommandId } from "./commands";
import { matchShortcut } from "./keymap";

/** Desabilitados, estes deixam a tecla seguir (copiar/selecionar texto de um painel, por exemplo). */
const PASS_THROUGH = new Set<CommandId>(["edit.copy", "edit.cut", "edit.selectAll", "edit.paste"]);

/** Único ouvinte de atalhos do app: tecla → comando do keymap → `runCommand`. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Diálogo modal aberto: as teclas são dele.
      if (e.target instanceof Element && e.target.closest("[aria-modal=true]")) return;
      const id = matchShortcut(e);
      if (!id) return;
      // Um Ctrl+tecla do app nunca cai no WebView (Ctrl+P imprime, Ctrl+R recarrega), mesmo desabilitado.
      if (runCommand(id) || (e.ctrlKey && !PASS_THROUGH.has(id))) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
