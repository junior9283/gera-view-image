// Registro central de comandos: menus, atalhos e barra de ferramentas executam só por aqui.
// Um comando sem `registerCommand` aparece desabilitado (itens de tarefas futuras).
import { notifyError } from "../chrome/notify";

export const ANNOTATE_KINDS = [
  "rect", "oval", "line", "arrow", "text", "bubble", "star", "polygon", "loupe", "highlight", "signature",
] as const;
export type AnnotateKind = (typeof ANNOTATE_KINDS)[number];

export const COMMAND_IDS = [
  // Arquivo
  "file.newFromClipboard", "file.open", "file.openRecent", "file.close", "file.save", "file.duplicate",
  "file.rename", "file.moveTo", "file.showInFolder", "file.revertLastSaved", "file.revertOriginal", "file.export",
  "file.exportSelected", "file.captureSelection", "file.captureWindow", "file.captureScreen", "file.print",
  "file.openWith", "file.quit",
  // Editar
  "edit.undo", "edit.redo", "edit.cut", "edit.copy", "edit.paste", "edit.delete", "edit.selectAll",
  "edit.deselect", "edit.invertSelection", "edit.preferences",
  // Visualizar
  "view.hideSidebar", "view.thumbnails", "view.contactSheet", "view.actualSize", "view.fit", "view.zoomIn",
  "view.zoomOut", "view.zoomToSelection", "view.markupBar", "view.slideshow", "view.fullscreen",
  // Ir
  "go.prev", "go.next", "go.first", "go.last",
  // Ferramentas
  "tools.rotateLeft", "tools.rotateRight", "tools.flipH", "tools.flipV", "tools.crop", "tools.adjustColor",
  "tools.resize", "tools.instantAlpha", "tools.inspector",
  ...ANNOTATE_KINDS.map((k) => `tools.annotate.${k}` as const),
  // Janela
  "window.minimize", "window.maximize",
  // Ajuda
  "help.shortcuts", "help.checkUpdates", "help.about",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

interface Command {
  run: () => unknown;
  enabled?: () => boolean;
}

const commands = new Map<CommandId, Command>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Registra (ou substitui) um comando. Devolve a função que o remove. */
export function registerCommand(id: CommandId, run: () => unknown, enabled?: () => boolean): () => void {
  const cmd = { run, enabled };
  commands.set(id, cmd);
  changed();
  return () => {
    if (commands.get(id) === cmd) {
      commands.delete(id);
      changed();
    }
  };
}

export const isRegistered = (id: CommandId) => commands.has(id);

export function isEnabled(id: CommandId): boolean {
  const c = commands.get(id);
  return !!c && (c.enabled?.() ?? true);
}

/** Executa se registrado e habilitado; erros (síncronos ou da promessa) viram notificação. */
export function runCommand(id: CommandId): boolean {
  const c = commands.get(id);
  if (!c || !(c.enabled?.() ?? true)) return false;
  try {
    void Promise.resolve(c.run()).catch(notifyError);
  } catch (e) {
    notifyError(e);
  }
  return true;
}

/** Para `useSyncExternalStore`: muda a cada (des)registro. */
export function subscribeCommands(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const commandsVersion = () => version;

/** Só para testes. */
export function resetCommandsForTests(): void {
  commands.clear();
  changed();
}
