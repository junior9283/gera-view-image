// Prévia de Ajustar Cor na imagem do visor (importado uma vez no `main.tsx`).
import { registerSlot } from "../lib/slots";
import { AdjustPreviewLayer } from "./AdjustPreviewLayer";

registerSlot("viewport-overlay", "adjust-preview", AdjustPreviewLayer);
