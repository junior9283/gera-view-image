// Popover do título (como o do Pré-Visualização): nome, etiquetas, local e Bloqueado.
// O botão entra pelo slot `title-accessory`, ao lado do nome na barra de título.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { notifyError } from "../chrome/notify";
import { dirname, moveActive, renameDoc, showInFolder } from "../file/fileActions";
import * as ipc from "../ipc/commands";
import type { DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { refreshLocked, setLocked } from "./actions";
import { closePopover, openPopover, useFinderUi } from "./store";
import { TagsInput } from "./TagsInput";
import "./finder.css";

const splitName = (name: string): [string, string] => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
};

function NameField({ doc }: { doc: DocInfo }) {
  const { t } = useTranslation();
  const [base, ext] = splitName(doc.name);
  const [value, setValue] = useState(base);
  const commit = () => {
    const v = value.trim();
    if (!v || v === base) return setValue(base);
    renameDoc(doc.id, v + ext).catch((e) => {
      notifyError(e);
      setValue(base);
    });
  };
  return (
    <label className="finder-row">
      <span>{t("finder.popover.name")}</span>
      <span className="finder-name">
        <input
          type="text" value={value} aria-label={t("finder.popover.name")}
          onChange={(e) => setValue(e.target.value)} onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        {ext && <span className="finder-ext">{ext}</span>}
      </span>
    </label>
  );
}

function TagsField({ doc, autoFocus }: { doc: DocInfo; autoFocus: boolean }) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    ipc.fileTags(doc.id).then((v) => live && setTags(v), (e) => {
      if (live) setTags([]);
      notifyError(e);
    });
    return () => {
      live = false;
    };
  }, [doc.id]);

  const save = (next: string[]) => {
    const before = tags;
    setTags(next);
    ipc.setFileTags(doc.id, next).then(setTags, (e) => {
      setTags(before);
      notifyError(e);
    });
  };
  return (
    <div className="finder-row">
      <span>{t("finder.popover.tags")}</span>
      <TagsInput tags={tags} onChange={save} autoFocus={autoFocus} />
    </div>
  );
}

function LockField({ doc }: { doc: DocInfo }) {
  const { t } = useTranslation();
  const locked = useFinderUi((s) => s.locked[doc.id]);
  useEffect(() => {
    refreshLocked(doc.id).catch(notifyError);
  }, [doc.id]);
  return (
    <>
      <label className="finder-check">
        <input
          type="checkbox" checked={!!locked} disabled={locked === undefined}
          onChange={(e) => void setLocked(doc.id, e.target.checked).catch(notifyError)}
        />
        {t("finder.popover.locked")}
      </label>
      {locked && <p className="finder-hint">{t("finder.popover.lockedHint")}</p>}
    </>
  );
}

export function TitlePopover({ doc, anchor, focusTags }: { doc: DocInfo; anchor: DOMRect | null; focusTags: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const folder = dirname(doc.path);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!ref.current?.contains(el) && !el?.closest?.(".finder-title-button")) closePopover();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePopover();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const left = anchor ? Math.max(8, Math.min(anchor.left + anchor.width / 2 - 150, window.innerWidth - 308)) : 8;
  return createPortal(
    <div
      ref={ref} className="finder-popover" role="dialog" aria-label={t("finder.popover.label")}
      style={{ left, top: anchor ? anchor.bottom + 6 : 40 }}
    >
      <NameField key={doc.name} doc={doc} />
      <TagsField doc={doc} autoFocus={focusTags} />
      <div className="finder-row">
        <span>{t("finder.popover.where")}</span>
        <span className="finder-where" title={folder}>{folder.slice(folder.lastIndexOf("/") + 1) || "/"}</span>
      </div>
      <div className="finder-actions">
        <button type="button" onClick={() => void moveActive().catch(notifyError)}>{t("finder.popover.move")}</button>
        <button type="button" onClick={() => void showInFolder().catch(notifyError)}>{t("finder.popover.reveal")}</button>
      </div>
      <LockField doc={doc} />
    </div>,
    document.body,
  );
}

/** Botão ao lado do nome (slot `title-accessory`) e o popover do documento ativo. */
export function TitleAccessory() {
  const { t } = useTranslation();
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  const { popover, focusTags } = useFinderUi();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = !!doc?.path && popover === doc.id;
  useLayoutEffect(() => {
    if (open) setAnchor(button.current?.getBoundingClientRect() ?? null);
  }, [open]);
  // Trocou de documento com o popover aberto: fecha.
  useEffect(() => {
    if (popover !== null && popover !== doc?.id) closePopover();
  }, [doc?.id, popover]);
  if (!doc?.path) return null;
  return (
    <>
      <button
        ref={button} type="button" className="finder-title-button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={t("finder.popover.open")} title={t("finder.popover.open")}
        onClick={() => (open ? closePopover() : openPopover(doc.id))}
      >
        ⌄
      </button>
      {open && <TitlePopover key={doc.id} doc={doc} anchor={anchor} focusTags={focusTags} />}
    </>
  );
}
