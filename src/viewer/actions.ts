// Ações do visualizador. A Task 6 liga estas funções aos menus e ao keymap completo.
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo } from "../ipc/types";
import { confirmClose } from "../file/unsaved";
import { useDocs } from "../store/docs";
import { getPrefs } from "../store/prefs";
import { useUi, type SidebarMode } from "../store/ui";
import { clampPan, fitState, nextStep, zoomAt, type Size, type ViewState } from "./zoom";

export function activeDoc(): DocInfo | null {
  const { docs, activeId } = useDocs.getState();
  return docs.find((d) => d.id === activeId) ?? null;
}

const imgSize = (d: DocInfo): Size => ({ w: d.width, h: d.height });

/** Documento que dá para mostrar no Viewport (sem erro e com tamanho). */
const viewable = (d: DocInfo | null): d is DocInfo => !!d && !d.error && d.width > 0 && d.height > 0;

/**
 * Recalcula a view do ativo para o tamanho atual da área. `reset` (troca de documento) aplica
 * `prefs.openBehavior`; senão `fit` continua ajustado e os demais modos só limitam o pan.
 */
export function syncView(reset = false): void {
  const d = activeDoc();
  const { view, viewSize, setView } = useUi.getState();
  if (!viewable(d) || viewSize.w <= 0 || viewSize.h <= 0) return setView(null);
  const img = imgSize(d);
  if (reset || !view) setView(fitState(img, viewSize, getPrefs().openBehavior));
  else if (view.mode === "fit") setView(fitState(img, viewSize, "fit"));
  else setView(clampPan(view, img, viewSize));
}

/** Aplica `f` à view atual (criando-a se preciso) e limita o pan. */
function changeView(f: (v: ViewState, img: Size, view: Size) => ViewState): void {
  const d = activeDoc();
  if (!viewable(d)) return;
  if (!useUi.getState().view) syncView(true);
  const { view, viewSize, setView } = useUi.getState();
  if (!view) return;
  setView(clampPan(f(view, imgSize(d), viewSize), imgSize(d), viewSize));
}

const center = (s: Size) => ({ x: s.w / 2, y: s.h / 2 });
const stepZoom = (dir: 1 | -1) => () =>
  changeView((v, _img, size) => zoomAt(v, nextStep(v.scale, dir) / v.scale, center(size)));

export const zoomIn = stepZoom(1);
export const zoomOut = stepZoom(-1);
export const actualSize = () => changeView((v, _img, size) => ({ ...zoomAt(v, 1 / v.scale, center(size)), mode: "actual" }));
export const fitToWindow = () => changeView((_v, img, size) => fitState(img, size, "fit"));

/** Zoom contínuo (Ctrl+roda, pinça) ancorado no cursor. */
export const zoomBy = (factor: number, anchor: { x: number; y: number }) => changeView((v) => zoomAt(v, factor, anchor));

/** Duplo clique: alterna entre ajustar e 100 % (ancorado no clique). */
export const toggleFitActual = (anchor: { x: number; y: number }) =>
  changeView((v, img, size) => (v.mode === "fit" ? { ...zoomAt(v, 1 / v.scale, anchor), mode: "actual" } : fitState(img, size, "fit")));

export const panBy = (dx: number, dy: number) => changeView((v) => ({ ...v, panX: v.panX + dx, panY: v.panY + dy }));

export function toggleSidebar(mode: Exclude<SidebarMode, "hidden">): void {
  const ui = useUi.getState();
  ui.setSidebar(ui.sidebar === mode ? "hidden" : mode);
}

// ---------- navegação ----------

type Dir = "next" | "prev" | "first" | "last";
interface NavOpts {
  /** Dá a volta nas pontas (apresentação). */
  wrap?: boolean;
}

function targetIndex(i: number, n: number, dir: Dir, wrap: boolean): number {
  if (dir === "first") return 0;
  if (dir === "last") return n - 1;
  if (dir === "next") return i + 1 < n ? i + 1 : wrap ? 0 : i;
  return i > 0 ? i - 1 : wrap ? n - 1 : i;
}

/** Fecha os documentos, perguntando antes se algum estiver sujo. */
export async function closeDocs(ids: DocId[]): Promise<void> {
  const docs = useDocs.getState().docs.filter((d) => ids.includes(d.id));
  if (!docs.length || (await confirmClose(docs)) !== "discard") return;
  for (const d of docs) await useDocs.getState().close(d.id);
}

/** Um só documento aberto: anda pela pasta dele, fechando o anterior (se não estiver sujo). */
async function goFolder(doc: DocInfo, dir: Dir, wrap: boolean): Promise<void> {
  const list = await ipc.folderImages(doc.path);
  let i = list.indexOf(doc.path);
  if (i < 0) i = list.findIndex((p) => p.slice(p.lastIndexOf("/") + 1) === doc.name);
  if (i < 0) return;
  const j = targetIndex(i, list.length, dir, wrap);
  if (j === i) return;
  const [opened] = await useDocs.getState().open([list[j]]);
  if (!opened) return;
  activate(opened.id);
  await closeDocs([doc.id]);
}

/** Ativa o documento (e volta à página padrão dele). */
export function activate(id: DocId, page: number | null = null): void {
  useUi.getState().setPage(page);
  useDocs.getState().setActive(id);
}

let inFlight: Promise<void> | null = null;

/** Navega; enquanto uma navegação pela pasta está em curso, novos pedidos são ignorados (tecla repetida). */
function go(dir: Dir, { wrap = false }: NavOpts = {}): Promise<void> {
  if (inFlight) return inFlight;
  const { docs, activeId } = useDocs.getState();
  if (!docs.length) return Promise.resolve();
  if (docs.length === 1 && getPrefs().browseFolder) {
    inFlight = goFolder(docs[0], dir, wrap)
      .catch((e) => console.error("falha ao navegar na pasta:", e))
      .finally(() => (inFlight = null));
    return inFlight;
  }
  const i = Math.max(0, docs.findIndex((d) => d.id === activeId));
  const j = targetIndex(i, docs.length, dir, wrap);
  if (j !== i || activeId === null) activate(docs[j].id);
  return Promise.resolve();
}

export const next = (o?: NavOpts) => go("next", o);
export const prev = (o?: NavOpts) => go("prev", o);
export const first = () => go("first");
export const last = () => go("last");

// ---------- tela cheia e apresentação ----------

export async function setFullscreen(on: boolean): Promise<void> {
  await getCurrentWindow().setFullscreen(on);
  useUi.setState({ fullscreen: on });
}

export const toggleFullscreen = () => setFullscreen(!useUi.getState().fullscreen);

let fullscreenBeforeShow = false;

export async function startSlideshow(): Promise<void> {
  const ui = useUi.getState();
  if (ui.slideshow || !useDocs.getState().docs.length) return;
  fullscreenBeforeShow = ui.fullscreen;
  useUi.setState({ slideshow: true });
  if (!ui.fullscreen) await setFullscreen(true).catch((e) => console.error("tela cheia indisponível:", e));
}

export async function stopSlideshow(): Promise<void> {
  if (!useUi.getState().slideshow) return;
  useUi.setState({ slideshow: false });
  if (!fullscreenBeforeShow) await setFullscreen(false).catch((e) => console.error(e));
}

/** Esc: sai da apresentação ou da tela cheia. */
export async function exitModes(): Promise<void> {
  if (useUi.getState().slideshow) return stopSlideshow();
  if (useUi.getState().fullscreen) return setFullscreen(false);
}
