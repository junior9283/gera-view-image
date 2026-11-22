// Lote 4 (Remover Fundo / Copiar Objeto): ponto de registro exclusivo deste lote, importado uma vez no
// `main.tsx`. "Copiar Objeto" do menu de contexto (Lote 2) é o mesmo comando `tools.copySubject`.
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { canSegment, copySubject, removeBackground } from "../subject/actions";
import { SubjectHost } from "../subject/SubjectHost";

registerCommand("tools.removeBackground", removeBackground, canSegment);
registerCommand("tools.copySubject", copySubject, canSegment);
registerSlot("above-content", "subject", SubjectHost);

export { selectSubject } from "../subject/actions";
