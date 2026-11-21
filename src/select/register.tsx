// Liga a camada de seleção e o menu de contexto ao Viewport pelo slot `viewport-overlay`, registra
// Colar como camada e o soltar imagem sobre a imagem (importado uma vez pelo App). Ponto de registro
// do Lote 2 (docs/arquitetura/extensao.md).
import { registerSlot, type OverlayProps } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { registerDropTarget } from "../viewer/fileDrop";
import { ImageContextMenu } from "./ContextMenu";
import { dropOnImage, pasteAsLayer } from "./paste";
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
registerSlot("viewport-overlay", "context-menu", ImageContextMenu);

// Colar: camada flutuante na imagem aberta (sem imagem aberta, Novo da Área de Transferência).
registerCommand("edit.paste", pasteAsLayer);

// Soltar um arquivo de imagem sobre a imagem aberta: camada no ponto do drop.
registerDropTarget((paths, { x, y }) => {
  const r = document.querySelector(".viewport")?.getBoundingClientRect();
  if (!r || x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
  return dropOnImage(paths, [x - r.left, y - r.top]);
});

// A seleção está em px do documento ativo: trocar de documento a descarta.
useDocs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useSelection.getState().setSelection(null);
});
