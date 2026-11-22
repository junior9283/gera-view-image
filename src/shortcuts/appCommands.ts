// Liga ao registro de comandos as ações que já existem. Itens de tarefas futuras (Salvar, Exportar,
// Imprimir, Colar, Anotar ▸…) ficam sem registro e, por isso, desabilitados nos menus.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { SUPPORTED_EXTENSIONS } from "../file/extensions";
import i18n from "../i18n";
import { openAdjustColor, openResize } from "../adjust/actions";
import { canRedo, canUndo, redo, undo } from "../edit/history";
import type { Op } from "../ipc/types";
import { toggleInspector } from "../inspector/toggle";
import { deleteSelected } from "../markup/actions";
import { copyAnnotations, cutAnnotations, duplicateAnnotations, focusedDoc, selectAllAnnotations } from "../markup/clipboard";
import { openAbout, openPreferences } from "../prefs/dialogs";
import * as sel from "../select/actions";
import { maskBounds } from "../select/lasso";
import { applyToTargets } from "../sidebar/batch";
import { batchTargets } from "../sidebar/selection";
import { useDocs } from "../store/docs";
import { quit } from "../tabs/closing";
import { openFiles } from "../file/openFiles";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { CHECK_UPDATES_EVENT } from "../updater/UpdateDialog";
import * as view from "../viewer/actions";
import { registerCommand, type CommandId } from "./commands";
import { SHOW_SHORTCUTS_EVENT, TOGGLE_MARKUP_EVENT } from "./events";

const fire = (name: string) => () => window.dispatchEvent(new Event(name));

/** Documento ativo que dá para editar e mostrar (sem erro e com tamanho). */
function editable() {
  const d = view.activeDoc();
  return view.viewable(d) ? d : null;
}
const hasDoc = () => !!editable();
const hasDocs = () => useDocs.getState().docs.length > 0;
const hasSelection = () => hasDoc() && !!useSelection.getState().selection;

/**
 * Op que muda a geometria: a seleção (em px da imagem) deixa de valer. Com várias miniaturas
 * selecionadas na barra lateral, vale para todas (cada uma com o próprio desfazer).
 */
async function transform(op: Op) {
  const d = editable();
  if (!d) return;
  await applyToTargets(batchTargets(), () => op);
  sel.deselect();
}

function zoomToSelection() {
  const d = editable();
  const { selection } = useSelection.getState();
  const r = d && selection && maskBounds(selection, d.width, d.height);
  if (r) view.zoomToRect(r);
}

/** Esc: sai da apresentação; senão desmarca; senão sai da ferramenta de seleção; senão, da tela cheia. */
function escape() {
  const ui = useUi.getState();
  if (ui.slideshow) return view.stopSlideshow();
  const { selection, selectionTool, setSelectionTool } = useSelection.getState();
  if (selection) return sel.deselect();
  if (selectionTool) return setSelectionTool(null);
  if (ui.fullscreen) return view.setFullscreen(false);
}

/** Com anotação selecionada, o comando de edição é dela (`onItems`); sem, da imagem. */
const onFocus = (onItems: (id: number) => unknown, onImage: () => unknown) => () => {
  const id = focusedDoc();
  return id === null ? onImage() : onItems(id);
};
const hasAnnotation = () => focusedDoc() !== null;
const hasTarget = () => hasAnnotation() || hasSelection();

const withActive = (f: (id: number) => unknown) => () => {
  const d = view.activeDoc();
  return d && f(d.id);
};
const activeCan = (f: (id: number) => boolean) => () => {
  const d = editable();
  return !!d && f(d.id);
};
const nav = (dir: "next" | "prev") => () => view[dir]({ wrap: useUi.getState().slideshow });

type Entry = [CommandId, () => unknown, (() => boolean)?];

/** Arquivo › Abrir…: diálogo do sistema filtrado pelas extensões que o núcleo abre. */
async function pickFiles() {
  const picked = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: i18n.t("dialog.images"), extensions: [...SUPPORTED_EXTENSIONS] }],
  });
  if (picked?.length) await openFiles(picked);
}

const ENTRIES: Entry[] = [
  ["file.open", pickFiles],
  ["file.close", withActive((id) => view.closeDocs([id])), () => !!view.activeDoc()],

  ["edit.undo", withActive(undo), activeCan(canUndo)],
  ["edit.redo", withActive(redo), activeCan(canRedo)],
  ["edit.cut", onFocus(cutAnnotations, sel.cutSelection), hasTarget],
  ["edit.copy", onFocus(copyAnnotations, sel.copySelection), hasDoc],
  ["edit.duplicate", onFocus(duplicateAnnotations, () => {}), hasAnnotation],
  ["edit.delete", onFocus(deleteSelected, sel.deleteSelection), hasTarget],
  ["edit.selectAll", onFocus(selectAllAnnotations, sel.selectAll), hasDoc],
  ["edit.deselect", escape, () => {
    const { slideshow, fullscreen } = useUi.getState();
    const { selection, selectionTool } = useSelection.getState();
    return slideshow || fullscreen || !!selection || !!selectionTool;
  }],
  ["edit.invertSelection", sel.invertSelection, hasSelection],
  ["edit.preferences", openPreferences],

  ["view.hideSidebar", () => useUi.getState().setSidebar("hidden")],
  ["view.thumbnails", () => view.toggleSidebar("thumbs")],
  ["view.contactSheet", () => view.toggleSidebar("contact")],
  ["view.actualSize", view.actualSize, hasDoc],
  ["view.fit", view.fitToWindow, hasDoc],
  ["view.zoomIn", view.zoomIn, hasDoc],
  ["view.zoomOut", view.zoomOut, hasDoc],
  ["view.zoomToSelection", zoomToSelection, hasSelection],
  ["view.markupBar", fire(TOGGLE_MARKUP_EVENT)],
  ["view.slideshow", view.startSlideshow, hasDocs],
  ["view.fullscreen", view.toggleFullscreen],

  ["go.prev", nav("prev"), hasDocs],
  ["go.next", nav("next"), hasDocs],
  ["go.first", view.first, hasDocs],
  ["go.last", view.last, hasDocs],

  ["tools.rotateLeft", () => transform({ type: "rotate", data: { quarterTurns: -1 } }), hasDoc],
  ["tools.rotateRight", () => transform({ type: "rotate", data: { quarterTurns: 1 } }), hasDoc],
  ["tools.flipH", () => transform({ type: "flipH" }), hasDoc],
  ["tools.flipV", () => transform({ type: "flipV" }), hasDoc],
  ["tools.crop", sel.cropToSelection, hasSelection],
  ["tools.adjustColor", openAdjustColor, hasDoc],
  ["tools.resize", openResize, hasDoc],
  ["tools.selectRect", () => sel.toggleSelectionTool("rect"), hasDoc],
  ["tools.selectEllipse", () => sel.toggleSelectionTool("ellipse"), hasDoc],
  ["tools.selectLasso", () => sel.toggleSelectionTool("lasso"), hasDoc],
  ["tools.selectSmartLasso", () => sel.toggleSelectionTool("smartLasso"), hasDoc],
  ["tools.instantAlpha", sel.startInstantAlpha, hasDoc],
  ["tools.inspector", toggleInspector],

  // Pergunta pelas alterações não salvas de todas as janelas.
  ["file.quit", quit],
  ["window.minimize", () => getCurrentWindow().minimize()],
  ["window.maximize", () => getCurrentWindow().toggleMaximize()],

  ["help.shortcuts", fire(SHOW_SHORTCUTS_EVENT)],
  ["help.checkUpdates", fire(CHECK_UPDATES_EVENT)],
  ["help.about", openAbout],
];

/** Registra os comandos do app; devolve a função que remove todos. */
export function registerAppCommands(): () => void {
  const offs = ENTRIES.map(([id, run, enabled]) => registerCommand(id, run, enabled));
  return () => offs.forEach((off) => off());
}
