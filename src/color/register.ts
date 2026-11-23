// Lote 1 (Cor (ColorSync)): Atribuir Perfil… e a preferência de correspondência de cor.
import { setColorManagement } from "../ipc/commands";
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { getPrefs, loadPrefs, subscribePrefs } from "../store/prefs";
import { activeDoc, viewable } from "../viewer/actions";
import { AssignProfileHost, openAssignProfile } from "./AssignProfileHost";
import "./proof";

registerCommand("tools.assignProfile", openAssignProfile, () => viewable(activeDoc()));
registerSlot("above-content", "assign-profile", AssignProfileHost);

// O Rust só lê o perfil do monitor quando recebe a preferência: avisa sempre uma vez, depois de
// ler as preferências do disco, e a cada mudança (em fila, para valer a última).
let applied: boolean | null = null;
let queue: Promise<unknown> = Promise.resolve();
function syncColorManagement() {
  const on = getPrefs().colorManagement;
  if (on === applied) return;
  applied = on;
  queue = queue.then(() => setColorManagement(on)).catch(console.error);
}
void loadPrefs().then(() => {
  subscribePrefs(syncColorManagement);
  syncColorManagement();
});
