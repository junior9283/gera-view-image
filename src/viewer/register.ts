// Lote 8 (Visualizar extras): Mostrar Lupa, Mostrar Fundo da Imagem, Voltar/Avançar e Fechar Todas.
// Importado uma vez no `main.tsx`; os registros valem pela vida do app. Guia: docs/arquitetura/extensao.md.
import { registerSlot } from "../lib/slots";
import { registerCommand, runCommand } from "../shortcuts/commands";
import { isTyping } from "../shortcuts/keymap";
import { useDocs } from "../store/docs";
import { getPrefs, setPrefs } from "../store/prefs";
import { activeDoc, closeDocs, viewable } from "./actions";
import { back, canBack, canForward, forward, installHistory } from "./history";
import { Magnifier, toggleMagnifier } from "./Magnifier";

const hasDocs = () => useDocs.getState().docs.length > 0;

registerCommand("tools.magnifier", toggleMagnifier, () => viewable(activeDoc()));
registerCommand("view.imageBackground", () => setPrefs({ showImageBackground: !getPrefs().showImageBackground }));
registerCommand("go.back", back, canBack);
registerCommand("go.forward", forward, canForward);
registerCommand("file.closeAll", () => closeDocs(useDocs.getState().docs.map((d) => d.id)), hasDocs);
registerSlot("viewport-overlay", "magnifier", Magnifier);
installHistory();

/**
 * A crase é tecla morta no ABNT2 (Shift+´) e no US-Internacional (`) e chega como "Dead": o keymap
 * não a distingue dos outros acentos, então a tecla física decide aqui.
 */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Dead" || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target)) return;
  if (document.querySelector('[aria-modal="true"]')) return;
  const grave = (e.code === "BracketLeft" && e.shiftKey) || (e.code === "Backquote" && !e.shiftKey);
  if (grave && runCommand("tools.magnifier")) e.preventDefault();
});
