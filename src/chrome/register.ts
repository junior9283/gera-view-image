// Lote 6 (Barra de ferramentas, Compartilhar e Ajuda): ponto de registro exclusivo deste lote, importado uma vez no `main.tsx`.
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { getPrefs, setPrefs } from "../store/prefs";
import { CUSTOMIZE_TOOLBAR_EVENT, CustomizeToolbar } from "./CustomizeToolbar";
import { HELP_SEARCH_EVENT } from "./MenuBar";
import { DevicePicker, hasDeviceShare, probeDeviceShare, shareByEmail, sharedDoc, shareToDevice } from "./share";

const fire = (name: string) => () => window.dispatchEvent(new Event(name));
const registerDevice = () => registerCommand("file.shareDevice", shareToDevice, () => hasDeviceShare() && !!sharedDoc());

registerCommand("view.toolbar", () => setPrefs({ toolbarHidden: !getPrefs().toolbarHidden }));
registerCommand("view.customizeToolbar", fire(CUSTOMIZE_TOOLBAR_EVENT));
registerCommand("file.shareEmail", shareByEmail, () => !!sharedDoc());
registerDevice();
registerCommand("help.search", fire(HELP_SEARCH_EVENT));
registerSlot("below-toolbar", "customize-toolbar", CustomizeToolbar);
registerSlot("below-toolbar", "device-picker", DevicePicker);

// O KDE Connect é opcional: o item só habilita se o `kdeconnect-cli` existir (registrar de novo avisa os menus).
void probeDeviceShare().then((ok) => ok && registerDevice());
