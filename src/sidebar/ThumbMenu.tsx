// Menu de contexto da miniatura (botão direito): age na seleção da barra, como no Pré-Visualização.
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { MenuList, type ActionItem, type ListItem } from "../chrome/MenuBar";
import { openFileDialog } from "../file/fileActions";
import { reveal } from "../ipc/commands";
import type { DocId, DocInfo, Op } from "../ipc/types";
import { runCommand } from "../shortcuts/commands";
import { activate, closeDocs } from "../viewer/actions";
import { applyToTargets, printSelection } from "./batch";

export interface MenuTarget {
  x: number;
  y: number;
  /** Miniatura sobre a qual o menu abriu. */
  pressed: DocInfo;
  /** Seleção em que as ações agem (inclui `pressed`). */
  ids: DocId[];
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Itens do menu: o que só faz sentido para uma imagem (Abrir, Mostrar na Pasta, Lixo) fica desabilitado em lote. */
export function thumbMenuItems({ pressed, ids }: MenuTarget, t: T): ListItem[] {
  const many = ids.length > 1;
  const sep: ListItem = { separator: true };
  const item = (key: string, run: () => unknown, disabled = false, opts?: Record<string, unknown>): ActionItem => ({
    text: t(`sidebar.menu.${key}`, opts),
    run: () => void Promise.resolve(run()).catch(notifyError),
    disabled,
  });
  const op = (key: string, o: Op) => item(key, () => applyToTargets(ids, () => o));
  const single = !many && !!pressed.path;
  const n = { count: ids.length };
  return [
    item("open", () => activate(pressed.id), many),
    sep,
    op("rotateLeft", { type: "rotate", data: { quarterTurns: -1 } }),
    op("rotateRight", { type: "rotate", data: { quarterTurns: 1 } }),
    op("flipH", { type: "flipH" }),
    op("flipV", { type: "flipV" }),
    sep,
    item("adjustColor", () => runCommand("tools.adjustColor")),
    item("resize", () => runCommand("tools.resize")),
    sep,
    item(
      many ? "exportMany" : "export",
      () => openFileDialog(many ? { kind: "exportSelected" } : { kind: "export", id: pressed.id, mode: "export" }),
      false,
      n,
    ),
    item(many ? "printMany" : "print", () => printSelection(ids), false, n),
    sep,
    item("reveal", () => reveal(pressed.id), !single),
    item("trash", () => runCommand("file.moveToTrash"), !single),
    item(many ? "closeMany" : "close", () => closeDocs(ids), false, n),
  ];
}

/** Menu aberto em `target` (portal, com o fundo que fecha ao clicar fora). */
export function ThumbMenu({ target, onClose }: { target: MenuTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);

  // Perto da borda da janela, o menu abre para o outro lado (como os menus do sistema).
  useLayoutEffect(() => {
    const el = box.current;
    const list = el?.firstElementChild?.getBoundingClientRect();
    if (!el || !list) return;
    if (list.right > window.innerWidth) el.style.left = `${Math.max(0, target.x - list.width)}px`;
    if (list.bottom > window.innerHeight) el.style.top = `${Math.max(0, target.y - list.height - 4)}px`;
  }, [target]);

  return createPortal(
    <>
      <div
        className="wm-backdrop"
        data-testid="thumb-menu-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div ref={box} className="image-context" style={{ position: "fixed", left: target.x, top: target.y, zIndex: 100 }}>
        <MenuList
          label={t("sidebar.itemMenu")}
          items={thumbMenuItems(target, (k, o) => t(k, o ?? {}))}
          level={0}
          autoFocus
          onRun={onClose}
          onClose={onClose}
          onCloseAll={onClose}
          onSwitch={() => {}}
        />
      </div>
    </>,
    document.body,
  );
}
