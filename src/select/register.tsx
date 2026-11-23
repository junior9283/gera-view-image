// Liga a camada de seleção e o menu de contexto ao Viewport pelo slot `viewport-overlay`, registra
// Colar como camada e o soltar imagem sobre a imagem (importado uma vez pelo App). Ponto de registro
// do Lote 2 (docs/arquitetura/extensao.md).
import { registerSlot, type OverlayProps } from "../lib/slots";
import { docOf, hasPages, useShownPage } from "../markup/pages";
import { registerCommand } from "../shortcuts/commands";
import { pasteThumbs } from "../sidebar/files";
import { sheetOpen } from "../sidebar/selection";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { registerDropTarget } from "../viewer/fileDrop";
import { ImageContextMenu } from "./ContextMenu";
import { dropOnImage, pasteAsLayer } from "./paste";
import { SelectionLayer } from "./SelectionLayer";

function SelectionOverlay({ scale, panX, panY, imageW, imageH }: OverlayProps) {
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId));
  const frame = useShownPage(doc);
  if (!doc) return null;
  return (
    <SelectionLayer
      // Outra página é outra imagem: o arrasto e o Alfa Instantâneo em andamento não passam para ela.
      key={`${doc.id}:${frame}`}
      frame={frame}
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
// Na folha de contatos não há imagem à vista: abre o que foi copiado.
registerCommand("edit.paste", () => (sheetOpen() ? pasteThumbs() : pasteAsLayer()));

// Soltar um arquivo de imagem sobre a imagem aberta: camada no ponto do drop.
registerDropTarget((paths, { x, y }) => {
  const r = document.querySelector(".viewport")?.getBoundingClientRect();
  if (!r || x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
  return dropOnImage(paths, [x - r.left, y - r.top]);
});

// A seleção está em px da imagem exibida: trocar de documento ou de página a descarta.
useDocs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useSelection.getState().setSelection(null);
});
useUi.subscribe((s, prev) => {
  const { activeId } = useDocs.getState();
  if ((s.page ?? 0) !== (prev.page ?? 0) && activeId !== null && hasPages(docOf(activeId))) useSelection.getState().setSelection(null);
});
