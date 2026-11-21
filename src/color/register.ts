// Lote 1 (Cor (ColorSync)): Atribuir Perfil… e a preferência de correspondência de cor.
import { setColorManagement } from "../ipc/commands";
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { getPrefs, subscribePrefs } from "../store/prefs";
import { activeDoc, viewable } from "../viewer/actions";
import { AssignProfileHost, openAssignProfile } from "./AssignProfileHost";

registerCommand("tools.assignProfile", openAssignProfile, () => viewable(activeDoc()));
registerSlot("above-content", "assign-profile", AssignProfileHost);

// O Rust começa com a correspondência ligada; só avisa quando a preferência for outra.
let applied = true;
function syncColorManagement() {
  const on = getPrefs().colorManagement;
  if (on === applied) return;
  applied = on;
  setColorManagement(on).catch(console.error);
}
subscribePrefs(syncColorManagement);
syncColorManagement();
