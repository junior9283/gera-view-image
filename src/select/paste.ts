// Colar como camada flutuante (Lote 2): a imagem da área de transferência, ou um arquivo solto
// sobre a imagem aberta, vira uma anotação `image` selecionada, que se move e redimensiona com a
// ferramenta Selecionar da Marcação e é achatada ao salvar, como no Pré-Visualização.
import { notifyError } from "../chrome/notify";
import { SUPPORTED_EXTENSIONS } from "../file/extensions";
import { newFromClipboard } from "../file/fileActions";
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { addAnnotation } from "../markup/actions";
import { pasteAnnotations } from "../markup/clipboard";
import { DEFAULT_STYLE, newId, type Box } from "../markup/model";
import { shownPage, shownSize } from "../markup/pages";
import { useMarkup } from "../markup/store";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { activeDoc, viewable } from "../viewer/actions";

interface Size { w: number; h: number }
type Point = [number, number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Largura e altura do IHDR; `null` se os bytes não forem PNG. */
export function pngSize(b: Uint8Array): Size | null {
  if (b.length < 24 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = { w: v.getUint32(16), h: v.getUint32(20) };
  return size.w > 0 && size.h > 0 ? size : null;
}

/** Caixa da camada: 1 pixel por pixel, reduzida (com a proporção) só se não couber, centrada em
 *  `center` e mantida dentro da imagem. */
export function layerBox(layer: Size, img: Size, [cx, cy]: Point): Box {
  const k = Math.min(1, img.w / layer.w, img.h / layer.h);
  const w = layer.w * k;
  const h = layer.h * k;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return { x: clamp(cx - w / 2, img.w - w), y: clamp(cy - h / 2, img.h - h), w, h };
}

const dataUrl = (b: Uint8Array) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(new Blob([b as BlobPart], { type: "image/png" }));
  });

/** Ponto da área do Viewport (px CSS) em pixels da imagem ativa; sem view, o centro da imagem. */
function toImage(img: Size, at?: Point): Point {
  const { view, viewSize } = useUi.getState();
  if (!view) return [img.w / 2, img.h / 2];
  const [sx, sy] = at ?? [viewSize.w / 2, viewSize.h / 2];
  return [(sx - view.panX) / view.scale, (sy - view.panY) / view.scale];
}

/** Documento e página em que o colar começou. */
interface Target { id: DocId; page: number }

function shownTarget(): Target | null {
  const doc = activeDoc();
  return viewable(doc) ? { id: doc.id, page: shownPage(doc.id) } : null;
}

/** O alvo ainda é o que está na tela (depois de um `await`, o usuário pode ter trocado de aba ou de página). */
const stillShown = (t: Target) => {
  const now = shownTarget();
  return now?.id === t.id && now.page === t.page;
};

/** Insere o PNG como camada selecionada em `to`, centrada em `at` (px do Viewport); desiste se `to` saiu da tela. */
async function insertLayer(png: Uint8Array, to: Target, at?: Point): Promise<void> {
  const doc = activeDoc();
  const size = pngSize(png);
  if (!viewable(doc) || !stillShown(to)) return;
  if (!size) throw { code: "clipboard_empty", message: "não é PNG" };
  const img = shownSize(doc);
  const box = layerBox(size, img, toImage(img, at));
  const src = await dataUrl(png);
  if (!stillShown(to)) return;
  const geom = { ...box, src };
  useSelection.getState().setSelection(null);
  const mk = useMarkup.getState();
  mk.setVisible(true);
  mk.setTool("select");
  addAnnotation(doc.id, { id: newId(), kind: "image", geom, style: { ...DEFAULT_STYLE } });
}

/** Editar › Colar: as anotações copiadas ou, se a última cópia for uma imagem, uma camada flutuante na
 *  imagem aberta; sem imagem aberta, um documento novo. */
export async function pasteAsLayer(): Promise<void> {
  const to = shownTarget();
  if (!to) return newFromClipboard();
  if (await pasteAnnotations()) return;
  await insertLayer(await ipc.clipboardImage(), to);
}

const isImagePath = (p: string) => {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  return p.includes(".") && (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
};

/**
 * Um arquivo de imagem solto sobre a imagem aberta vira camada no ponto `at` (px CSS da área do
 * Viewport). Devolve `false` quando o drop não é para colar (fora da imagem, vários arquivos ou sem
 * documento): aí ele abre como documento, o comportamento de sempre.
 */
export function dropOnImage(paths: string[], at: Point): boolean {
  const doc = activeDoc();
  if (paths.length !== 1 || !isImagePath(paths[0]) || !viewable(doc) || !useUi.getState().view) return false;
  const img = shownSize(doc);
  const [x, y] = toImage(img, at);
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return false;
  const to = { id: doc.id, page: shownPage(doc.id) };
  ipc.imageFilePng(paths[0]).then((png) => insertLayer(png, to, at)).catch(notifyError);
  return true;
}
