// Ações do visualizador, ligadas aos menus e ao keymap em src/shortcuts/appCommands.ts.
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as ipc from "../ipc/commands";
import type { DocId, DocInfo, Rect } from "../ipc/types";
import { confirmAndSave } from "../file/unsaved";
import { hasPages, pageSize } from "../lib/pages";
import { useDocs } from "../store/docs";
import { getPrefs } from "../store/prefs";
import { notElsewhere } from "../tabs/open";
import { useUi, type SidebarMode } from "../store/ui";
import { dpr } from "./paint";
import { zoomUnit } from "./unit";
import { clampPan, fitState, nextStep, rectState, zoomAt, type Size, type ViewState } from "./zoom";

export function activeDoc(): DocInfo | null {
  const { docs, activeId } = useDocs.getState();
  return docs.find((d) => d.id === activeId) ?? null;
}

const imgSize = (d: DocInfo): Size => pageSize(d, useUi.getState().page);

/** Documento que dá para mostrar no Viewport (sem erro e com tamanho). */
export const viewable = (d: DocInfo | null): d is DocInfo => !!d && !d.error && d.width > 0 && d.height > 0;

/**
 * Recalcula a view do ativo para o tamanho atual da área e a escala da tela. `reset` (troca de
 * documento) aplica `prefs.openBehavior`; senão `fit` continua ajustado, `actual` continua em
 * 100% (ancorado no centro) e `free` só limita o pan.
 */
export function syncView(reset = false): void {
  const d = activeDoc();
  const { view, viewSize, setView } = useUi.getState();
  if (!viewable(d) || viewSize.w <= 0 || viewSize.h <= 0) return setView(null);
  const img = imgSize(d);
  const mode = reset || !view ? getPrefs().openBehavior : view.mode;
  if (mode === "fit") setView(fitted(img, viewSize));
  else if (reset || !view) setView(fitState(img, viewSize, "actual", zoomUnit()));
  else if (view.mode === "actual") setView(clampPan(toActual(view, center(viewSize)), img, viewSize));
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

/** Ajustado à janela: nunca passa de 1 px da imagem por px físico. */
const fitted = (img: Size, view: Size) => fitState(img, view, "fit", dpr());

/** Tamanho Real (100% de `zoomUnit`) ancorado em `anchor`. */
function toActual(v: ViewState, anchor: { x: number; y: number }): ViewState {
  const k = zoomUnit();
  return { ...zoomAt(v, 1 / (k * v.scale), anchor, k), mode: "actual" };
}

const stepZoom = (dir: 1 | -1) => () =>
  changeView((v, _img, size) => {
    const k = zoomUnit();
    return zoomAt(v, nextStep(v.scale, dir, k) / v.scale, center(size), k);
  });

export const zoomIn = stepZoom(1);
export const zoomOut = stepZoom(-1);
export const actualSize = () => changeView((v, _img, size) => toActual(v, center(size)));
export const fitToWindow = () => changeView((_v, img, size) => fitted(img, size));

/** Ampliar Seleção: enquadra o retângulo (px da imagem). */
export const zoomToRect = (r: Rect) => changeView((_v, _img, size) => rectState(r, size, zoomUnit()));

/** Zoom contínuo (Ctrl+roda, pinça) ancorado no cursor. */
export const zoomBy = (factor: number, anchor: { x: number; y: number }) => changeView((v) => zoomAt(v, factor, anchor, zoomUnit()));

/** Duplo clique: alterna entre ajustar e 100 % (ancorado no clique). */
export const toggleFitActual = (anchor: { x: number; y: number }) =>
  changeView((v, img, size) => (v.mode === "fit" ? toActual(v, anchor) : fitted(img, size)));

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
  /** Vindo da página anterior: a imagem de várias páginas abre na última. */
  lastPage?: boolean;
}

/** Página em que `d` abre: a última, se pedida e se ele tem páginas; senão a padrão. */
const landing = (d: DocInfo, lastPage = false): number | null => (lastPage && hasPages(d) ? d.frames - 1 : null);

function targetIndex(i: number, n: number, dir: Dir, wrap: boolean): number {
  if (dir === "first") return 0;
  if (dir === "last") return n - 1;
  if (dir === "next") return i + 1 < n ? i + 1 : wrap ? 0 : i;
  return i > 0 ? i - 1 : wrap ? n - 1 : i;
}

/** Fecha os documentos, perguntando antes (Salvar / Não Salvar / Cancelar) se algum estiver sujo. */
export async function closeDocs(ids: DocId[]): Promise<void> {
  const docs = useDocs.getState().docs.filter((d) => ids.includes(d.id));
  if (!docs.length || !(await confirmAndSave(docs))) return;
  for (const d of docs) await useDocs.getState().close(d.id);
}

/** Um só documento aberto: anda pela pasta dele, fechando o anterior (se não estiver sujo). */
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Aproxima a ordem natural do Rust (`folder_images`). */
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Índice do vizinho na pasta; `null` = fica onde está. */
function folderTarget(list: string[], doc: DocInfo, dir: Dir, wrap: boolean): number | null {
  const n = list.length;
  let i = list.indexOf(doc.path);
  if (i < 0) i = list.findIndex((p) => baseName(p) === doc.name);
  if (i >= 0) {
    const j = targetIndex(i, n, dir, wrap);
    return j === i ? null : j;
  }
  // O arquivo saiu da pasta (apagado/renomeado por fora): anda a partir da posição em que estaria.
  if (!n) return null;
  const at = list.findIndex((p) => natural.compare(baseName(p), doc.name) > 0);
  const ins = at < 0 ? n : at;
  if (dir === "first") return 0;
  if (dir === "last") return n - 1;
  if (dir === "next") return ins < n ? ins : wrap ? 0 : null;
  return ins > 0 ? ins - 1 : wrap ? n - 1 : null;
}

async function goFolder(doc: DocInfo, dir: Dir, { wrap = false, lastPage }: NavOpts): Promise<void> {
  let list = await ipc.folderImages(doc.path);
  for (;;) {
    const j = folderTarget(list, doc, dir, wrap);
    if (j === null) return;
    const path = list[j];
    if ((await notElsewhere([path])).length) return goTo(path, doc, lastPage);
    // Aberto em outra janela: pula, sem tirar o foco desta.
    list = list.filter((p) => p !== path);
  }
}

async function goTo(path: string, doc: DocInfo, lastPage?: boolean): Promise<void> {
  const [opened] = await useDocs.getState().open([path]);
  if (!opened) return;
  activate(opened.id, landing(opened, lastPage));
  await closeDocs([doc.id]);
}

/** Ativa o documento (e volta à página padrão dele). */
export function activate(id: DocId, page: number | null = null): void {
  useUi.getState().setPage(page);
  useDocs.getState().setActive(id);
}

let inFlight: Promise<void> | null = null;

/** Navega; enquanto uma navegação pela pasta está em curso, novos pedidos são ignorados (tecla repetida). */
function go(dir: Dir, opts: NavOpts = {}): Promise<void> {
  if (inFlight) return inFlight;
  const { docs, activeId } = useDocs.getState();
  if (!docs.length) return Promise.resolve();
  const wrap = opts.wrap ?? false;
  if (docs.length === 1 && getPrefs().browseFolder) {
    inFlight = goFolder(docs[0], dir, opts)
      .catch((e) => console.error("falha ao navegar na pasta:", e))
      .finally(() => (inFlight = null));
    return inFlight;
  }
  const i = Math.max(0, docs.findIndex((d) => d.id === activeId));
  const j = targetIndex(i, docs.length, dir, wrap);
  if (j !== i || activeId === null) activate(docs[j].id, landing(docs[j], opts.lastPage));
  return Promise.resolve();
}

/**
 * ←/→ e PgUp/PgDn: a página seguinte/anterior de um TIFF. Na ponta passa para a imagem vizinha, como
 * a barra lateral do Pré-Visualização, que lista as páginas de cada imagem em sequência; voltando, a
 * anterior abre na última página. Sem páginas, é o mesmo que ↑/↓.
 */
function stepPage(dir: 1 | -1, o: NavOpts = {}): Promise<void> {
  const d = activeDoc();
  const page = (useUi.getState().page ?? 0) + dir;
  if (!inFlight && d && hasPages(d) && page >= 0 && page < d.frames) {
    useUi.getState().setPage(page);
    return Promise.resolve();
  }
  return go(dir > 0 ? "next" : "prev", { ...o, lastPage: dir < 0 });
}

export const next = (o?: NavOpts) => go("next", o);
export const prev = (o?: NavOpts) => go("prev", o);
export const nextPage = (o?: NavOpts) => stepPage(1, o);
export const prevPage = (o?: NavOpts) => stepPage(-1, o);
export const first = () => go("first");
export const last = () => go("last");

// ---------- tela cheia e apresentação ----------

export async function setFullscreen(on: boolean): Promise<void> {
  await getCurrentWindow().setFullscreen(on);
  useUi.setState({ fullscreen: on });
}

/** Copia o estado real da janela (o gerenciador de janelas também pode mudar a tela cheia). */
export async function syncFullscreen(): Promise<void> {
  const on = await getCurrentWindow().isFullscreen();
  if (useUi.getState().fullscreen !== on) useUi.setState({ fullscreen: on });
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
