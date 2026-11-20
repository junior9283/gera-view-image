import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import { addAnnotation } from "./actions";
import { DEFAULT_STYLE, newId, type Point } from "./model";
import {
  MAX_SIGNATURES,
  catmullRom,
  importSignature,
  loadSignatures,
  removeSignature,
  addSignature,
  signatureSrc,
  strokesToPng,
  useSignatures,
  type Signature,
} from "./signatures";

const PAD_W = 360;
const PAD_H = 120;
const INK = "#000000";
const INK_WIDTH = 2.5;
/** Largura da assinatura inserida, em px de tela. */
const INSERT_PX = 200;

/** Insere a assinatura no centro da parte visível da imagem, com 200 px de tela de largura. */
async function insert(sig: Signature) {
  const docs = useDocs.getState();
  const doc = docs.docs.find((d) => d.id === docs.activeId);
  if (!doc) return;
  const src = signatureSrc(sig);
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => {});
  const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.33;
  const { view, viewSize } = useUi.getState();
  const scale = view?.scale ?? 1;
  const w = Math.min(doc.width, INSERT_PX / scale);
  const h = w * ratio;
  // Centro da área visível, em coordenadas da imagem (o centro da imagem sem view).
  const cx = view ? (viewSize.w / 2 - view.panX) / scale : doc.width / 2;
  const cy = view ? (viewSize.h / 2 - view.panY) / scale : doc.height / 2;
  addAnnotation(doc.id, { id: newId(), kind: "signature", geom: { x: cx - w / 2, y: cy - h / 2, w, h, src }, style: { ...DEFAULT_STYLE } });
}

function DrawTab() {
  const { t } = useTranslation();
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const cur = useRef<Point[] | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PAD_W, PAD_H);
    ctx.strokeStyle = INK;
    ctx.lineWidth = INK_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      ctx.beginPath();
      catmullRom(s).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }, [strokes]);

  const at = (e: ReactPointerEvent): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const save = async () => {
    const png = strokesToPng(strokes, INK, INK_WIDTH);
    if (!png) return;
    await addSignature(png);
    setStrokes([]);
  };

  return (
    <div className="sig-draw">
      <canvas
        ref={canvas}
        width={PAD_W}
        height={PAD_H}
        className="sig-pad"
        aria-label={t("markup.sig.pad")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          cur.current = [at(e)];
          setStrokes((s) => [...s, cur.current!]);
        }}
        onPointerMove={(e) => {
          if (!cur.current) return;
          cur.current.push(at(e));
          setStrokes((s) => [...s.slice(0, -1), [...cur.current!]]);
        }}
        onPointerUp={() => (cur.current = null)}
      />
      <p className="sig-hint">{t("markup.sig.drawHint")}</p>
      <div className="sig-actions">
        <button type="button" onClick={() => setStrokes([])} disabled={!strokes.length}>{t("markup.sig.clear")}</button>
        <button type="button" onClick={() => void save()} disabled={!strokes.length}>{t("markup.sig.save")}</button>
      </div>
    </div>
  );
}

function ImportTab() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs).filter((d) => !d.error);
  const activeId = useDocs((s) => s.activeId);
  const [from, setFrom] = useState<number | null>(activeId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const chosen = docs.find((d) => d.id === from) ?? docs[0];

  const run = async () => {
    if (!chosen) return;
    setBusy(true);
    setFailed(false);
    try {
      if (!(await importSignature(chosen.id))) setFailed(true);
    } catch (e) {
      console.error("falha ao importar a assinatura:", e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sig-import">
      <p className="sig-hint">{t("markup.sig.importHint")}</p>
      <label>
        {t("markup.sig.importFrom")}
        <select value={chosen?.id ?? ""} onChange={(e) => setFrom(Number(e.target.value))}>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
      {failed && <p className="sig-error" role="alert">{t("markup.sig.importFailed")}</p>}
      <div className="sig-actions">
        <button type="button" onClick={() => void run()} disabled={!chosen || busy}>{t("markup.sig.importButton")}</button>
      </div>
    </div>
  );
}

/** Painel de Assinatura: salvas (inserir/apagar) e criar (Desenhar ou Importar Imagem). */
export function SignaturePanel({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const list = useSignatures();
  const [tab, setTab] = useState<"draw" | "import">("draw");

  useEffect(() => {
    void loadSignatures();
  }, []);

  return (
    <div role="dialog" aria-label={t("markup.sig.title")} className="markup-menu sig-panel" data-testid="signature-panel">
      <div className="markup-menu-label">{t("markup.sig.title")}</div>
      {list.length === 0 ? (
        <p className="sig-hint">{t("markup.sig.none")}</p>
      ) : (
        <ul className="sig-list">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" className="sig-insert" aria-label={t("markup.sig.insert")} title={t("markup.sig.insert")} onClick={() => void insert(s).then(onDone)}>
                <img src={signatureSrc(s)} alt="" />
              </button>
              <button type="button" className="sig-remove" aria-label={t("markup.sig.remove")} title={t("markup.sig.remove")} onClick={() => void removeSignature(s.id)}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 2l8 8M10 2l-8 8" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="markup-menu-label">{t("markup.sig.create")}</div>
      <div role="tablist" className="sig-tabs">
        <button type="button" role="tab" aria-selected={tab === "draw"} onClick={() => setTab("draw")}>{t("markup.sig.draw")}</button>
        <button type="button" role="tab" aria-selected={tab === "import"} onClick={() => setTab("import")}>{t("markup.sig.import")}</button>
      </div>
      {tab === "draw" ? <DrawTab /> : <ImportTab />}
      <p className="sig-hint">{t("markup.sig.limit", { n: MAX_SIGNATURES })}</p>
    </div>
  );
}
