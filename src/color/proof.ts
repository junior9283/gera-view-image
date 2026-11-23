// Visualizar › Prova de Cor com Perfil (L12): mostra como a imagem sairia em outro perfil (CMYK, cinza
// ou RGB). Só na tela e por documento: o perfil fica no Rust com o documento; aqui vai uma cópia do
// nome, para marcar o item do menu, que acompanha a aba ao mudar de janela.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { refreshDynamicMenus, registerDynamicMenu } from "../chrome/dynamicMenus";
import type { ActionItem, ListItem } from "../chrome/MenuBar";
import { notifyError } from "../chrome/notify";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { ColorProfile, DocId } from "../ipc/types";
import { registerDocState } from "../lib/docState";
import { registerCommand } from "../shortcuts/commands";
import { activeDoc, viewable } from "../viewer/actions";

const proofs = new Map<DocId, ColorProfile>();
/** Perfis instalados; `null` até o submenu abrir pela primeira vez. */
let installed: ColorProfile[] | null = null;

function remember(id: DocId, p: ColorProfile | null) {
  if (p) proofs.set(id, p);
  else proofs.delete(id);
  refreshDynamicMenus();
}

/** Perfil de prova do documento, ou `null`. */
export const proofOf = (id: DocId): ColorProfile | null => proofs.get(id) ?? null;

/** Troca o perfil de prova do documento (`null` = nenhum). */
export async function setProof(id: DocId, profile: string | null): Promise<void> {
  remember(id, await ipc.setProofProfile(id, profile));
}

const set = (profile: string | null) => {
  const doc = activeDoc();
  if (doc) void setProof(doc.id, profile).catch(notifyError);
};

async function chooseFile(): Promise<void> {
  const id = activeDoc()?.id;
  if (id === undefined) return;
  const path = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: i18n.t("color.iccFiles"), extensions: ["icc", "icm", "ICC", "ICM"] }],
  });
  if (typeof path === "string") await setProof(id, path);
}

async function loadInstalled(): Promise<void> {
  if (installed) return;
  installed = [];
  try {
    installed = await ipc.listProofProfiles();
  } catch (e) {
    installed = null;
    notifyError(e);
  }
  refreshDynamicMenus();
}

const canProof = () => viewable(activeDoc());

registerCommand("view.softProofNone", () => set(null), canProof);
registerCommand("view.softProofChoose", () => void chooseFile().catch(notifyError), canProof);

registerDynamicMenu("menu.view.softProof", {
  onOpen: () => void loadInstalled(),
  build: (items) => {
    const doc = activeDoc();
    const now = doc ? proofOf(doc.id) : null;
    const radio = (p: ColorProfile): ActionItem => ({ text: p.name, checked: now?.id === p.id, run: () => set(p.id) });
    const list = installed ?? [];
    // Arquivo escolhido fora das pastas do sistema: entra na lista enquanto estiver em uso.
    const shown = now && !list.some((p) => p.id === now.id) ? [...list, now] : list;
    return items.flatMap((it): ListItem[] => {
      if (!("command" in it) || it.command !== "view.softProofNone") return [it];
      const none: ActionItem = { text: i18n.t(it.label), checked: !now, run: () => set(null), disabled: !canProof() };
      return shown.length ? [none, { separator: true }, ...shown.map(radio)] : [none];
    });
  },
});

registerDocState("proof", {
  dump: (id) => proofs.get(id),
  load: (id, data) => remember(id, data as ColorProfile),
  drop: (id) => remember(id, null),
});

/** Só para testes. */
export function resetProofForTests(): void {
  proofs.clear();
  installed = null;
}
