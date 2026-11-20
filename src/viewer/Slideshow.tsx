import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { usePrefs } from "../store/prefs";
import { next, prev, stopSlideshow } from "./actions";
import { FitImage } from "./FitImage";
import "./viewer.css";

/** Duração do fade entre imagens (igual à transição do CSS). */
export const FADE_MS = 300;
const CONTROLS_MS = 2500;

/** A imagem anterior continua por FADE_MS para o fade cruzado. */
function useOutgoing(doc: DocInfo | null): DocInfo | null {
  const [state, setState] = useState<{ current: DocInfo | null; outgoing: DocInfo | null }>({ current: doc, outgoing: null });
  if (state.current?.id !== doc?.id) setState({ current: doc, outgoing: state.current });
  else if (state.current !== doc) setState({ ...state, current: doc });
  const outgoing = state.outgoing;
  useEffect(() => {
    if (!outgoing) return;
    const t = setTimeout(() => setState((s) => (s.outgoing === outgoing ? { ...s, outgoing: null } : s)), FADE_MS);
    return () => clearTimeout(t);
  }, [outgoing]);
  return outgoing;
}

export function Slideshow() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const seconds = usePrefs().slideshowSeconds;
  const doc = docs.find((d) => d.id === activeId) ?? null;
  const outgoing = useOutgoing(doc);
  const [playing, setPlaying] = useState(true);
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Avanço automático; trocar de imagem (por tecla ou botão) reinicia a contagem.
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => void next({ wrap: true }), seconds * 1000);
    return () => clearTimeout(timer);
  }, [playing, activeId, seconds]);

  const wake = () => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), CONTROLS_MS);
  };

  useEffect(() => {
    hideTimer.current = setTimeout(() => setControls(false), CONTROLS_MS);
    const onKey = (e: KeyboardEvent) => {
      // Com foco num botão, o Space é dele (ativa o botão).
      if (e.key !== " " || (e.target instanceof HTMLElement && e.target.closest("button"))) return;
      e.preventDefault();
      setPlaying((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(hideTimer.current);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const layers = [outgoing?.id !== doc?.id ? outgoing : null, doc].filter((d): d is DocInfo => !!d);
  const index = docs.findIndex((d) => d.id === activeId);

  return (
    <div className={`slideshow${controls ? "" : " idle"}`} role="dialog" aria-label={t("slideshow.label")} onPointerMove={wake}>
      {layers.map((d) => (
        <FitImage key={d.id} doc={d} className={d === outgoing ? "slide fade-out" : "slide fade-in"} />
      ))}
      <div className="slideshow-controls">
        <button type="button" aria-label={t("slideshow.prev")} onClick={() => void prev({ wrap: true })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <button type="button" aria-label={t(playing ? "slideshow.pause" : "slideshow.play")} onClick={() => setPlaying((p) => !p)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{playing ? <path d="M8 5v14M16 5v14" /> : <path d="M7 5l12 7-12 7z" />}</svg>
        </button>
        <button type="button" aria-label={t("slideshow.next")} onClick={() => void next({ wrap: true })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
        <span className="slideshow-index">{t("slideshow.index", { i: index + 1, n: docs.length })}</span>
        <button type="button" aria-label={t("slideshow.exit")} onClick={() => void stopSlideshow()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </div>
  );
}
