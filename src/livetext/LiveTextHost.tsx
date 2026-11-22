import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import { notify, notifyError } from "../chrome/notify";
import { useModal } from "../lib/modal";
import { useUi } from "../store/ui";
import { activeDoc, panBy } from "../viewer/actions";
import { useConfirm } from "./actions";
import { closeFind, setFindQuery, stepFind, useLiveText } from "./store";
import "../file/file.css";
import "./livetext.css";

/** Copia a imagem e abre a busca por imagem; nada é enviado sem o usuário colar na página. */
async function searchImage() {
  const doc = activeDoc();
  if (!doc) return;
  await ipc.copyRegion(doc.id, null);
  await ipc.openWeb("images", "", "");
  notify(i18n.t("livetext.imageCopied"));
}

/** Confirmação de "Pesquisar Imagem na Web" ou de um `mailto:`/`tel:` lido da imagem. */
function ConfirmDialog() {
  const { t } = useTranslation();
  const pending = useConfirm((s) => s.pending);
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = () => useConfirm.setState({ pending: null });
  useModal(dialog, { active: !!pending, initialFocus: cancel, onClose: close });
  if (!pending) return null;
  const info = pending.kind === "link" ? pending.info : null;
  const link = info?.href ?? null;
  const go = () => {
    close();
    void (link ? ipc.openWeb("link", link, "") : searchImage()).catch(notifyError);
  };
  const testId = link ? "link-confirm" : "image-search";
  return (
    <div className="file-backdrop" role="presentation">
      <div ref={dialog} className="file-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} data-testid={`${testId}-dialog`}>
        <h3 id={titleId}>
          {t(
            !link
              ? "livetext.imageSearchTitle"
              : link.startsWith("tel:")
                ? "livetext.linkPhoneTitle"
                : link.startsWith("mailto:")
                  ? "livetext.linkEmailTitle"
                  : "livetext.linkWebTitle",
          )}
        </h3>
        {link ? (
          <>
            <p>{t(info?.idn ? "livetext.linkIdnBody" : "livetext.linkBody")}</p>
            {info?.host && <p className="livetext-confirm-target"><strong>{info.host}</strong></p>}
            <p className="livetext-confirm-target">{link}</p>
          </>
        ) : (
          <p>{t("livetext.imageSearchBody")}</p>
        )}
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" ref={cancel} data-testid={`${testId}-cancel`} onClick={close}>{t("livetext.cancel")}</button>
          <button type="button" className="file-primary" data-testid={`${testId}-open`} onClick={go}>
            {t(link ? "livetext.linkOpen" : "livetext.imageSearchGo")}
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
      <ConfirmDialog />
    </>
  );
}
