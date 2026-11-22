// Lote 11 (Exportar e Imprimir completos): ponto de registro exclusivo deste lote, importado uma vez
// no `main.tsx`. Imprimir (Ctrl+P), Exportar como PDF e o diálogo (slot `above-content`, que existe
// também em tela cheia). Guia: docs/arquitetura/extensao.md.
import { current } from "../file/fileActions";
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { exportPdf, printDocs } from "./print";
import { PrintHost } from "./PrintDialog";

const hasDoc = () => !!current();

registerCommand("file.print", () => printDocs(), hasDoc);
registerCommand("file.exportPdf", () => exportPdf(), hasDoc);
registerSlot("above-content", "print-host", PrintHost);
