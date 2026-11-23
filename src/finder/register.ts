// Lote 5 (Finder no Linux): ponto de registro exclusivo deste lote, importado uma vez no `main.tsx`.
// Salvar Como, Mover para o Lixo, Etiquetas, Bloquear, Procurar Todas as Versões, o popover do
// título (slot `title-accessory`) e os diálogos (slot `above-content`). Guia: docs/arquitetura/extensao.md.
import { current } from "../file/fileActions";
import * as ipc from "../ipc/commands";
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { selectedDocs } from "../sidebar/selection";
import { getPrefs, subscribePrefs } from "../store/prefs";
import { activeFile, moveActiveToTrash, saveAsActive, toggleLockActive } from "./actions";
import { FinderHost } from "./FinderHost";
import { openPopover, openVersions } from "./store";
import { TitleAccessory } from "./TitlePopover";

const hasFile = () => !!activeFile();
const withFile = (f: (id: number) => unknown) => () => {
  const d = activeFile();
  return d && f(d.id);
};

registerCommand("file.saveAs", saveAsActive, () => !!current());
registerCommand("file.moveToTrash", moveActiveToTrash, () => selectedDocs().some((d) => d.path));
registerCommand("file.tags", withFile((id) => openPopover(id, true)), hasFile);
registerCommand("file.lock", toggleLockActive, hasFile);
registerCommand("file.browseVersions", withFile(openVersions), hasFile);
registerSlot("title-accessory", "finder-title", TitleAccessory);
registerSlot("above-content", "finder-host", FinderHost);

// Limite das versões (`prefs.versionsMaxMb`) para o Rust, agora e a cada mudança.
let sentMb: number | null = null;
function syncVersionsLimit(): void {
  const mb = getPrefs().versionsMaxMb;
  if (mb === sentMb) return;
  sentMb = mb;
  ipc.setVersionsLimit(mb).catch(() => {
    sentMb = null;
  });
}
syncVersionsLimit();
subscribePrefs(syncVersionsLimit);
