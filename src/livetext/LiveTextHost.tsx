import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import { notify, notifyError } from "../chrome/notify";
import { useModal } from "../lib/modal";
import { useUi } from "../store/ui";
import { activeDoc, panBy } from "../viewer/actions";
import { closeFind, setFindQuery, stepFind, useLiveText } from "./store";
import "../file/file.css";
import "./livetext.css";

/** Pedido de "Pesquisar Imagem na Web" aguardando confirmação. */
export const useImageSearch = create<{ open: boolean }>(() => ({ open: false }));
export const askImageSearch = () => useImageSearch.setState({ open: true });

/** Copia a imagem e abre a busca por imagem; nada é enviado sem o usuário colar na página. */
async function searchImage() {
  useImageSearch.setState({ open: false });
  const doc = activeDoc();
  if (!doc) return;
  await ipc.copyRegion(doc.id, null);
  await ipc.openWeb("images", "", "");
  notify(i18n.t("livetext.imageCopied"));
}

function ImageSearchDialog() {
  const { t } = useTranslation();
  const open = useImageSearch((s) => s.open);
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = () => useImageSearch.setState({ open: false });
  useModal(dialog, { active: open, initialFocus: cancel, onClose: close });
  if (!open) return null;
  return (
    <div className="file-backdrop" role="presentation">
      <div ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} data-testid="image-search-dialog">
        <h3 id={titleId}>{t("livetext.imageSearchTitle")}</h3>
        <p>{t("livetext.imageSearchBody")}</p>
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" ref={cancel} onClick={close}>{t("livetext.cancel")}</button>
          <button type="button" className="file-primary" onClick={() => void searchImage().catch(notifyError)}>
            {t("livetext.imageSearchGo")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Barra Localizar (Ctrl+F) no texto reconhecido: leva a ocorrência atual para a área visível. */
function FindBar() {
  const { t } = useTranslation();
  const { find, model } = useLiveText();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (find.open) input.current?.select();
  }, [find.open]);
  const match = find.matches[find.index];
  useEffect(() => {
    const w = match && model?.words[match.words[0]];
    const { view, viewSize } = useUi.getState();
    if (!w || !view) return;
    const cx = view.panX + (w.bbox.x + w.bbox.w / 2) * view.scale;
    const cy = view.panY + (w.bbox.y + w.bbox.h / 2) * view.scale;
    const margin = 24;
    if (cx < margin || cy < margin || cx > viewSize.w - margin || cy > viewSize.h - margin) {
      panBy(viewSize.w / 2 - cx, viewSize.h / 2 - cy);
    }
  }, [match, model]);
  if (!find.open) return null;
  const count = find.matches.length;
  return (
    <div className="livetext-find-bar" role="search" data-testid="livetext-find-bar">
      <input
        ref={input}
        type="search"
        value={find.query}
        placeholder={t("livetext.findPlaceholder")}
        aria-label={t("livetext.findPlaceholder")}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            stepFind(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeFind();
          }
        }}
      />
      <span className="livetext-find-count" aria-live="polite">
        {find.query.trim() ? (count ? t("livetext.findCount", { n: find.index + 1, count }) : t("livetext.findNone")) : ""}
      </span>
      <button type="button" aria-label={t("menu.edit.findPrev")} title={t("menu.edit.findPrev")} disabled={!count} onClick={() => stepFind(-1)}>‹</button>
      <button type="button" aria-label={t("menu.edit.findNext")} title={t("menu.edit.findNext")} disabled={!count} onClick={() => stepFind(1)}>›</button>
      <button type="button" onClick={closeFind}>{t("livetext.done")}</button>
    </div>
  );
}

/** Montado no slot `below-toolbar`: barra Localizar e confirmação da busca por imagem. */
export function LiveTextHost() {
  return (
    <>
      <FindBar />
      <ImageSearchDialog />
    </>
  );
}
