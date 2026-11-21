// Lote 3 (Texto ao Vivo (OCR)): ponto de registro exclusivo deste lote, importado uma vez no `main.tsx`.
import { registerCommand } from "../shortcuts/commands";
import { registerSlot } from "../lib/slots";
import { activeDoc, viewable } from "../viewer/actions";
import { copyAll, hasText, isSpeaking, lookUp, startSpeaking, stopSpeaking, toggleLiveText } from "./actions";
import { LiveTextHost, askImageSearch } from "./LiveTextHost";
import { LiveTextLayer } from "./LiveTextLayer";
import { openFind, startLiveText, stepFind, useLiveText } from "./store";

const hasMatches = () => useLiveText.getState().find.matches.length > 0;

registerCommand("edit.find", openFind, hasText);
registerCommand("edit.findNext", () => stepFind(1), hasMatches);
registerCommand("edit.findPrev", () => stepFind(-1), hasMatches);
registerCommand("edit.startSpeaking", startSpeaking, hasText);
registerCommand("edit.stopSpeaking", stopSpeaking, isSpeaking);
registerCommand("tools.liveText", toggleLiveText);
registerCommand("tools.copyAllText", copyAll, hasText);
registerCommand("tools.translateText", () => lookUp("translate"), hasText);
registerCommand("tools.searchText", () => lookUp("search"), hasText);
registerCommand("tools.searchImageWeb", askImageSearch, () => viewable(activeDoc()));

registerSlot("viewport-overlay", "livetext", LiveTextLayer);
registerSlot("below-toolbar", "livetext", LiveTextHost);

startLiveText();
