// Liga a camada de seleção ao Viewport pelo slot `viewport-overlay` e registra Colar (importado uma
// vez pelo App). Ponto de registro do Lote 2 (docs/arquitetura/extensao.md).
import { newFromClipboard } from "../file/fileActions";
import { registerSlot, type OverlayProps } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
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

// Colar é do Lote 2 (colar como camada flutuante). Até lá, faz o mesmo que Novo da Área de Transferência.
registerCommand("edit.paste", newFromClipboard);

// A seleção está em px do documento ativo: trocar de documento a descarta.
useDocs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useSelection.getState().setSelection(null);
});
