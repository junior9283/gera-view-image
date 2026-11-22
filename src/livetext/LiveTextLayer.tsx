import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import type { Rect } from "../ipc/types";
import type { OverlayProps } from "../lib/slots";
import { notifyError } from "../chrome/notify";
import { useMarkup } from "../markup/store";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { copySelected, linkTitle, openLink } from "./actions";
import { LiveTextMenu, type MenuAt } from "./LiveTextMenu";
import { downloadModels, isLink, setSelection, toggleHighlight, useLiveText } from "./store";
import { wordAt, type TextModel } from "./text";
import "./livetext.css";

/** Retângulos de tela (um por linha) que cobrem as palavras `words`. */
function lineRects(m: TextModel, words: number[]): Rect[] {
  const byLine = new Map<number, Rect>();
  for (const i of words) {
    const w = m.words[i];
    if (!w) continue;
    const r = byLine.get(w.line);
    if (!r) byLine.set(w.line, { ...w.bbox });
    else {
      const x1 = Math.max(r.x + r.w, w.bbox.x + w.bbox.w);
      const y1 = Math.max(r.y + r.h, w.bbox.y + w.bbox.h);
      r.x = Math.min(r.x, w.bbox.x);
      r.y = Math.min(r.y, w.bbox.y);
      r.w = x1 - r.x;
      r.h = y1 - r.y;
    }
  }
  return [...byLine.values()];
}

const range = (a: number, b: number) => {
  const [i, j] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: j - i + 1 }, (_, k) => i + k);
};

/** Camada do Texto ao Vivo sobre a imagem: palavras selecionáveis, destaques e o botão do canto. */
export function LiveTextLayer({ scale, panX, panY }: OverlayProps) {
  const { t } = useTranslation();
  const { status, model, data, codes, highlight, sel, find, progress } = useLiveText();
  useLiveText((s) => s.links); // o `title` dos links muda quando o Rust responde
  const markupOn = useMarkup((s) => s.visible);
  const selectionTool = useSelection((s) => s.selectionTool);
  const slideshow = useUi((s) => s.slideshow);
  const root = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [offer, setOffer] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const interactive = !!model && !markupOn && !selectionTool && !slideshow;

  const box = (r: Rect) => ({ left: panX + r.x * scale, top: panY + r.y * scale, width: r.w * scale, height: r.h * scale });

  // Clique fora do texto desfaz a seleção; Ctrl+C copia o texto selecionado; Esc desmarca.
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest?.("[data-word], .livetext-menu")) setSelection(null);
    };
    const onKey = (e: KeyboardEvent) => {
      const copy = e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c";
      // Com uma seleção da imagem, Ctrl+C continua copiando a imagem.
      if (copy && !useSelection.getState().selection) {
        e.preventDefault();
        e.stopPropagation();
        void copySelected().catch(notifyError);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSelection(null);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [sel]);

  // Ouvintes nativos: a Viewport faz pan no `pointerdown` nativo, antes do React ver o evento.
  const cur = useRef({ model, scale, panX, panY });
  useEffect(() => {
    cur.current = { model, scale, panX, panY };
  });
  useEffect(() => {
    const el = root.current!;
    let multi = false;
    const toImage = (e: MouseEvent) => {
      const { scale, panX, panY } = cur.current;
      const r = el.getBoundingClientRect();
      return [(e.clientX - r.left - panX) / scale, (e.clientY - r.top - panY) / scale] as const;
    };
    const wordOf = (e: Event) => {
      const w = (e.target as Element | null)?.closest?.("[data-word]");
      return w ? Number(w.getAttribute("data-word")) : null;
    };
    const onDown = (e: PointerEvent) => {
      // Botões da camada recebem o clique sem iniciar o pan.
      if ((e.target as Element | null)?.closest?.("[data-livetext-stop]")) return e.stopPropagation();
      const i = wordOf(e);
      const { model } = cur.current;
      if (i === null || !model || e.button !== 0) return;
      // O arraste no texto seleciona (não faz pan na imagem).
      e.stopPropagation();
      e.preventDefault();
      setMenu(null);
      multi = false;
      const current = useLiveText.getState().sel;
      const anchor = e.shiftKey && current ? current.a : i;
      let moved = e.shiftKey;
      if (e.shiftKey) setSelection({ a: anchor, b: i });
      const onMove = (ev: PointerEvent) => {
        const [x, y] = toImage(ev);
        const j = wordAt(model, x, y, true);
        if (j === null || (j === anchor && !moved)) return;
        moved = true;
        setSelection({ a: anchor, b: j });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // Clique simples sem arrastar não seleciona (como um cursor de texto).
        if (!moved && !multi) setSelection(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    // Duplo clique seleciona a palavra; triplo, a linha (o `detail` do mousedown conta os cliques).
    const onMouseDown = (e: MouseEvent) => {
      const i = wordOf(e);
      const { model } = cur.current;
      if (i === null || !model || e.detail < 2) return;
      multi = true;
      if (e.detail === 2) return setSelection({ a: i, b: i });
      const line = model.words.flatMap((w, k) => (w.line === model.words[i].line ? [k] : []));
      setSelection({ a: line[0], b: line[line.length - 1] });
    };
    // Não alterna Ajustar/Tamanho Real ao clicar duas vezes numa palavra.
    const onDouble = (e: MouseEvent) => wordOf(e) !== null && e.stopPropagation();
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("dblclick", onDouble);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("dblclick", onDouble);
    };
  }, []);

  const onContext = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const s = useLiveText.getState().sel;
    const inSel = s && i >= Math.min(s.a, s.b) && i <= Math.max(s.a, s.b);
    if (!inSel) setSelection({ a: i, b: i });
    const r = root.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const selRects = model && sel ? lineRects(model, range(sel.a, sel.b)) : [];
  const findRects = model && find.open ? find.matches.map((m, k) => ({ k, rects: lineRects(model, m.words) })) : [];
  const hasText = !!model && (model.words.length > 0 || codes.length > 0);

  return (
    <div ref={root} className="livetext-layer" data-testid="livetext-layer">
      {highlight && model && (
        <>
          <div className="livetext-dim" />
          {model.lines.map((l, k) => (
            <div key={k} className="livetext-line" style={box(l.bbox)} />
          ))}
        </>
      )}
      {findRects.map(({ k, rects }) =>
        rects.map((r, j) => (
          <div
            key={`${k}-${j}`}
            className={`livetext-find${k === find.index ? " current" : ""}`}
            data-testid="livetext-find"
            style={box(r)}
          />
        )),
      )}
      {selRects.map((r, k) => (
        <div key={k} className="livetext-sel" data-testid="livetext-sel" style={box(r)} />
      ))}
      {interactive &&
        model.words.map((w, i) => (
          <div
            key={i}
            className="livetext-word"
            data-word={i}
            style={box(w.bbox)}
            onContextMenu={(e) => onContext(e, i)}
          />
        ))}
      {highlight &&
        model &&
        data.map((d, k) =>
          lineRects(model, d.words).map((r, j) => (
            <button
              key={`${k}-${j}`}
              type="button"
              className="livetext-data"
              data-testid="livetext-data"
              title={t(`livetext.open.${d.kind}`, { text: linkTitle(d.href) })}
              aria-label={t(`livetext.open.${d.kind}`, { text: linkTitle(d.href) })}
              style={box(r)}
              data-livetext-stop
              onClick={() => void openLink(d.href).catch(notifyError)}
            />
          )),
        )}
      {highlight &&
        codes.map((c, k) => {
          const link = isLink(c.text);
          return (
            <div key={k} className="livetext-code" style={box(c.bbox)}>
              <button
                type="button"
                className="livetext-chip"
                data-testid="livetext-code"
                data-livetext-stop
                title={link ? linkTitle(c.text) : c.text}
                onClick={() => void (link ? openLink(c.text) : ipc.copyText(c.text)).catch(notifyError)}
              >
                {t(link ? "livetext.qrOpen" : "livetext.qrCopy")}
              </button>
            </div>
          );
        })}
      {menu && <LiveTextMenu at={menu} onClose={() => setMenu(null)} />}
      {!slideshow && hasText && (
        <button
          type="button"
          className={`livetext-button${highlight ? " on" : ""}`}
          data-testid="livetext-button"
          aria-pressed={highlight}
          title={t("livetext.button")}
          aria-label={t("livetext.button")}
          data-livetext-stop
          onClick={toggleHighlight}
        >
          <LiveTextIcon />
        </button>
      )}
      {!slideshow && !dismissed && (status === "needsModels" || status === "downloading") && (
        <button
          type="button"
          className="livetext-button"
          data-testid="livetext-download"
          title={t("livetext.needsModels")}
          aria-label={t("livetext.needsModels")}
          disabled={status === "downloading"}
          data-livetext-stop
          onClick={() => setOffer(true)}
        >
          {status === "downloading" ? <span className="livetext-pct">{Math.round(progress * 100)}%</span> : <LiveTextIcon />}
        </button>
      )}
      {offer && status === "needsModels" && (
        <div className="livetext-offer" role="dialog" aria-label={t("livetext.offerTitle")} data-livetext-stop>
          <strong>{t("livetext.offerTitle")}</strong>
          <p>{t("livetext.offerBody")}</p>
          <div className="livetext-offer-actions">
            <button type="button" onClick={() => (setOffer(false), setDismissed(true))}>
              {t("livetext.notNow")}
            </button>
            <button
              type="button"
              className="primary"
              data-testid="livetext-download-confirm"
              onClick={() => {
                setOffer(false);
                void downloadModels();
              }}
            >
              {t("livetext.download")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Ícone próprio: cantos de enquadramento com linhas de texto. */
export const LiveTextIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M2 6V3.5A1.5 1.5 0 0 1 3.5 2H6M12 2h2.5A1.5 1.5 0 0 1 16 3.5V6M16 12v2.5a1.5 1.5 0 0 1-1.5 1.5H12M6 16H3.5A1.5 1.5 0 0 1 2 14.5V12" />
    <path d="M5.5 7h7M5.5 9.5h7M5.5 12h4" />
  </svg>
);
