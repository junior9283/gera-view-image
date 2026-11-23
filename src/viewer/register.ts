// Lote 8 (Visualizar extras): Mostrar Lupa, Mostrar Fundo da Imagem, Voltar/Avançar e Fechar Todas.
// Importado uma vez no `main.tsx`; os registros valem pela vida do app. Guia: docs/arquitetura/extensao.md.
import * as ipc from "../ipc/commands";
import { registerSlot } from "../lib/slots";
import { registerCommand, runCommand } from "../shortcuts/commands";
import { isTyping } from "../shortcuts/keymap";
import { useDocs } from "../store/docs";
import { getPrefs, setPrefs } from "../store/prefs";
import { hasPages } from "../lib/pages";
import { useUi } from "../store/ui";
import { activeDoc, closeDocs, nextPage, prevPage, viewable } from "./actions";
import { back, canBack, canForward, forward, installHistory } from "./history";
import { Magnifier, toggleMagnifier } from "./Magnifier";

const hasDocs = () => useDocs.getState().docs.length > 0;

/** Fecha os documentos desta janela e depois as outras janelas (cada uma pergunta pelos seus). */
async function closeAll() {
  await closeDocs(useDocs.getState().docs.map((d) => d.id));
  if (!hasDocs()) await ipc.closeOtherWindows();
}

registerCommand("tools.magnifier", toggleMagnifier, () => viewable(activeDoc()));
registerCommand("view.imageBackground", () => setPrefs({ showImageBackground: !getPrefs().showImageBackground }));
registerCommand("go.back", back, canBack);
registerCommand("go.forward", forward, canForward);
registerCommand("file.closeAll", closeAll, hasDocs);
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

/**
 * ←/→ e PgUp/PgDn num TIFF de várias páginas trocam de página (↑/↓ continuam trocando de imagem, pelo
 * keymap). Antes do `useShortcuts`; quem já tratou a tecla (seleção parcial, anotação, miniaturas) vence.
 */
const PAGE_KEYS: Record<string, 1 | -1> = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 };
window.addEventListener("keydown", (e) => {
  const dir = PAGE_KEYS[e.key];
  if (!dir || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || isTyping(e.target)) return;
  const { slideshow, sidebar } = useUi.getState();
  if (slideshow || sidebar === "contact" || !hasPages(activeDoc()) || document.querySelector('[aria-modal="true"]')) return;
  e.preventDefault();
  void (dir > 0 ? nextPage() : prevPage());
});
