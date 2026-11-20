// Gancho do E2E e das capturas de tela (scripts/screenshots.mjs): só no build com VITE_E2E=1.
// Executa comandos pelo registro central e mostra o diálogo de atualização com dados fictícios.
import { createRoot } from "react-dom/client";
import { runCommand, type CommandId } from "../shortcuts/commands";
import { UpdateDialog } from "../updater/UpdateDialog";
import type { UpdateInfo } from "../updater/updater";

export function installE2eHook(): void {
  Object.assign(window, {
    __gviE2E: {
      run: (id: CommandId) => runCommand(id),
      showUpdate: (info: UpdateInfo) => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        const root = createRoot(host);
        root.render(<UpdateDialog info={info} onClose={() => (root.unmount(), host.remove())} />);
      },
    },
  });
}
