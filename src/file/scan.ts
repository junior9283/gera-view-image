// Arquivo › Importar do Scanner: liga o comando (desabilitado, com dica, sem `scanimage` no PATH) e
// monta o diálogo (`ScanDialog`). A digitalização em si é do Rust (`commands/scan.rs`).
import * as ipc from "../ipc/commands";
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { ScanDialog, useScan } from "./ScanDialog";

/** `null` = ainda não se sabe (o item fica desabilitado, sem dica). */
let available: boolean | null = null;

/** Dica do item desabilitado (chave de i18n). */
export const scannerHint = (): string | undefined => (available === false ? "scan.missing" : undefined);

export function registerScanner(): () => void {
  const command = () => registerCommand("file.importScanner", () => useScan.setState({ open: true }), () => !!available);
  const offs = [command(), registerSlot("above-content", "scan-dialog", ScanDialog)];
  let alive = true;
  const known = (v: boolean) => {
    available = v;
    // Registrar de novo avisa os menus (habilitação e dica).
    if (alive) offs.push(command());
  };
  ipc.scanAvailable().then(known, () => known(false));
  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}
