// Liga a camada de seleção ao Viewport pelo slot `viewport-overlay` (importado uma vez pelo App).
import { registerSlot, type OverlayProps } from "../lib/slots";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { SelectionLayer } from "./SelectionLayer";

function SelectionOverlay({ scale, panX, panY, imageW, imageH }: OverlayProps) {
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId));
  if (!doc) return null;
  return (
    <SelectionLayer
      key={doc.id}
      docId={doc.id}
      format={doc.format}
      imageWidth={imageW}
      imageHeight={imageH}
      scale={scale}
      panX={panX}
      panY={panY}
    />
  );
}

registerSlot("viewport-overlay", "selection", SelectionOverlay);

// A seleção está em px do documento ativo: trocar de documento a descarta.
useDocs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useSelection.getState().setSelection(null);
});
