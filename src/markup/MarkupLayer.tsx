import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocInfo } from "../ipc/types";
import type { OverlayProps } from "../lib/slots";
import { toImage } from "../select/tools";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { dpr } from "../viewer/paint";
import { addAnnotation, commit, deleteSelected } from "./actions";
import { loadSource } from "./flatten";
import { cssFont } from "./fontCss";
import { DEFAULT_FONT, hitTest, moveItems, normBox, type Annotation, type Point } from "./model";
import { onCurrentPage, onPage, pageItems } from "./pages";
import { render, renderSelection, type Source, type ViewXf } from "./render";
import { getItems, getSelected, useItems, useMarkup, type ShapeTool, type Tool } from "./store";
import { createShape, createStroke, createText, toImageStyle } from "./tools/create";
import { dragHandle, handlesFor, hitHandle, type HandleId } from "./tools/handles";

/** Resolução máxima (lado maior) dos pixels usados pela Lupa na tela. */
const LOUPE_SOURCE_MAX = 2048;
/** Tolerância de clique numa anotação, em px de tela. */
const HIT_PX = 4;
const NO_IDS: string[] = [];

type Drag =
  | { kind: "create"; tool: ShapeTool; start: Point }
  | { kind: "stroke"; points: Point[]; sketch: boolean }
  | { kind: "move"; start: Point; before: Annotation[]; ids: string[] }
  | { kind: "handle"; start: Point; before: Annotation[]; orig: Annotation; handle: HandleId };

const isShape = (t: Tool): t is ShapeTool => !["select", "sketch", "draw", "text"].includes(t);

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Pixels do documento para a Lupa, só quando há lupa; recarrega a cada revisão. */
function useLoupeSource(doc: DocInfo | null, needed: boolean, page: number): Source | null {
  const [src, setSrc] = useState<{ key: string; s: Source } | null>(null);
  const key = doc ? `${doc.id}:${doc.rev}:${page}` : "";
  useEffect(() => {
    if (!needed || !doc || doc.error || src?.key === key) return;
    let alive = true;
    loadSource(doc.id, doc.width, doc.height, LOUPE_SOURCE_MAX, page)
      .then((s) => alive && setSrc({ key, s }))
      .catch((e) => console.error("falha ao carregar a imagem da lupa:", e));
    return () => {
      alive = false;
    };
  }, [needed, key, doc, src?.key, page]);
  return src?.key === key ? src.s : null;
}

/** Atalhos locais da camada: Delete apaga as selecionadas; Esc desmarca e volta à Seleção. */
function useMarkupKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useMarkup.getState();
      const id = useDocs.getState().activeId;
      const selecting = useSelection.getState().selectionTool !== null; // Delete/Esc são da seleção
      if (!st.visible || id === null || st.editing || selecting || isEditable(e.target)) return;
      let used = false;
      if (e.key === "Delete" || e.key === "Backspace") used = deleteSelected(id);
      else if (e.key === "Escape") {
        if (getSelected(id).length) st.select(id, []);
        else if (st.tool !== "select") st.setTool("select");
        else return;
        used = true;
      }
      if (used) {
        // Captura na window: o Apagar/Desmarcar da imagem (menus) não roda junto.
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Camada de anotações sobre a imagem (slot `viewport-overlay`). */
export function MarkupLayer({ scale, panX, panY, imageW, imageH }: OverlayProps) {
  const { t } = useTranslation();
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  const docId = doc?.id ?? null;
  const all = useItems(docId);
  const page = useUi((s) => s.page);
  const items = useMemo(() => onPage(all, doc, page), [all, doc, page]);
  const visible = useMarkup((s) => s.visible);
  const tool = useMarkup((s) => s.tool);
  const selected = useMarkup((s) => (docId === null ? NO_IDS : (s.selected[docId] ?? NO_IDS)));
  const editing = useMarkup((s) => s.editing);
  // Com uma ferramenta de seleção da imagem ativa, o ponteiro é da SelectionLayer (Task 7).
  const selecting = useSelection((s) => s.selectionTool !== null);
  const active = visible && !selecting;
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [imgTick, imageLoaded] = useReducer((x: number) => x + 1, 0);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const source = useLoupeSource(doc, items.some((a) => a.kind === "loupe"), page ?? 0);
  useMarkupKeys();

  /** Estado atual para os ouvintes nativos (registrados uma vez). */
  const cur = useRef({ docId, view: { scale, panX, panY } as ViewXf });
  useLayoutEffect(() => {
    cur.current = { docId, view: { scale, panX, panY } };
  });

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const k = dpr();
    const [w, h] = [Math.round(size.w * k), Math.round(size.h * k)];
    if (cv.width !== w || cv.height !== h) [cv.width, cv.height] = [w, h];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const view = { scale, panX, panY };
    const shown = draft ? [...items, draft] : items;
    render(ctx, shown, view, source, { imageW, imageH, dpr: k, skip: editing }, imageLoaded);
    if (visible) renderSelection(ctx, items, selected, view, k);
  }, [items, draft, selected, size, scale, panX, panY, imageW, imageH, source, editing, visible, imgTick]);

  // Ponteiro: ouvintes nativos, para impedir o pan do Viewport (ouvinte nativo no ancestral).
  useEffect(() => {
    const el = wrap.current!;
    const at = (e: MouseEvent): Point => {
      const r = el.getBoundingClientRect();
      return toImage(cur.current.view, e.clientX - r.left, e.clientY - r.top);
    };

    const onDown = (e: PointerEvent) => {
      if (isEditable(e.target)) {
        e.stopPropagation(); // clique no texto em edição
        return;
      }
      const id = cur.current.docId;
      const st = useMarkup.getState();
      if (!st.visible || id === null || e.button !== 0) return;
      const p = at(e);
      const { scale } = cur.current.view;
      const items = getItems(id);
      let d: Drag | null = null;
      if (st.tool === "select") {
        const sel = getSelected(id);
        const shown = pageItems(id);
        for (const a of shown) {
          if (!sel.includes(a.id)) continue;
          const h = hitHandle(handlesFor(a, scale), p[0], p[1], scale);
          if (h) d = { kind: "handle", start: p, before: items, orig: a, handle: h.id };
        }
        if (!d) {
          const hit = hitTest(shown, p[0], p[1], HIT_PX / scale);
          if (!hit) {
            st.select(id, []);
            return; // área vazia: o arrasto continua sendo o pan do Viewport
          }
          const ids = e.shiftKey
            ? sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]
            : sel.includes(hit.id) ? sel : [hit.id];
          st.select(id, ids);
          d = { kind: "move", start: p, before: items, ids };
        }
      } else if (st.tool === "text") {
        // Entra no histórico só ao confirmar o texto (TextEditor).
        const a = onCurrentPage(id, createText(p, st.style, scale, ""));
        st.setItems(id, [...items, a]);
        st.select(id, [a.id]);
        st.setTool("select");
        st.setEditing(a.id);
      } else if (st.tool === "sketch" || st.tool === "draw") {
        d = { kind: "stroke", points: [p], sketch: st.tool === "sketch" };
      } else if (isShape(st.tool)) {
        d = { kind: "create", tool: st.tool, start: p };
      }
      e.stopPropagation();
      e.preventDefault();
      drag.current = d;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ponteiro já liberado (ou ambiente sem captura) */
      }
    };

    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const id = cur.current.docId;
      if (!d || id === null) return;
      const p = at(e);
      const { scale } = cur.current.view;
      const st = useMarkup.getState();
      if (d.kind === "create") setDraft(createShape(d.tool, d.start, p, st.style, scale));
      else if (d.kind === "stroke") {
        d.points.push(p);
        setDraft({ id: "draft", kind: "freehand", geom: { points: d.points }, style: toImageStyle(st.style, scale) });
      } else if (d.kind === "move") st.setItems(id, moveItems(d.before, d.ids, p[0] - d.start[0], p[1] - d.start[1]));
      else {
        const next = dragHandle(d.orig, d.handle, p[0], p[1], d.start, scale);
        st.setItems(id, d.before.map((a) => (a.id === d.orig.id ? next : a)));
      }
    };

    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      const id = cur.current.docId;
      drag.current = null;
      setDraft(null);
      if (!d || id === null) return;
      const p = at(e);
      const { scale } = cur.current.view;
      const st = useMarkup.getState();
      if (d.kind === "create") {
        addAnnotation(id, createShape(d.tool, d.start, p, st.style, scale));
        st.setTool("select");
      } else if (d.kind === "stroke") {
        const a = createStroke(d.points, st.style, scale, d.sketch);
        if (a) addAnnotation(id, a, false);
      } else commit(id, getItems(id), d.before);
    };

    const onDouble = (e: MouseEvent) => {
      const id = cur.current.docId;
      const st = useMarkup.getState();
      if (!st.visible || id === null) return;
      const p = at(e);
      const hit = hitTest(pageItems(id), p[0], p[1], HIT_PX / cur.current.view.scale);
      if (hit?.kind === "text") {
        e.stopPropagation();
        st.setEditing(hit.id);
      } else if (hit) e.stopPropagation(); // não alterna Ajustar/Tamanho real sobre uma anotação
    };

    const listeners: [string, EventListener][] = [
      ["pointerdown", onDown as EventListener],
      ["pointermove", onMove as EventListener],
      ["pointerup", onUp as EventListener],
      ["pointercancel", onUp as EventListener],
      ["dblclick", onDouble as EventListener],
    ];
    for (const [n, f] of listeners) el.addEventListener(n, f);
    return () => {
      for (const [n, f] of listeners) el.removeEventListener(n, f);
    };
  }, []);

  const editingItem = items.find((a) => a.id === editing && a.kind === "text");
  const cursor = !active ? undefined : tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div
      ref={wrap}
      className="markup-layer"
      data-testid="markup-layer"
      aria-label={t("markup.layer")}
      style={{ pointerEvents: active ? "auto" : "none", cursor }}
    >
      <canvas ref={canvas} className="markup-canvas" />
      {docId !== null && editingItem?.kind === "text" && (
        <TextEditor key={editingItem.id} docId={docId} item={editingItem} view={{ scale, panX, panY }} />
      )}
    </div>
  );
}

/** `<textarea>` sobre o texto em edição; confirma ao sair (vazio apaga). */
function TextEditor({ docId, item, view }: { docId: number; item: Extract<Annotation, { kind: "text" }>; view: ViewXf }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(item.geom.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const f = item.style.font ?? DEFAULT_FONT;
  const b = normBox(item.geom);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = () => {
    const st = useMarkup.getState();
    if (st.editing !== item.id) return;
    st.setEditing(null);
    const text = value.replace(/\s+$/, "");
    if (text && text === item.geom.text) return; // nada mudou: sem passo no desfazer
    const items = getItems(docId);
    const without = items.filter((a) => a.id !== item.id);
    // Texto recém-criado (vazio) ainda não está no histórico: o "antes" é sem ele.
    const before = item.geom.text === "" ? without : items;
    if (!text) {
      commit(docId, without, before);
      return;
    }
    const lines = text.split("\n");
    const w = Math.max(b.w, f.size * 2, ...lines.map((l) => l.length * f.size * 0.62));
    const next = { ...item, geom: { ...item.geom, text, w, h: lines.length * f.size * 1.25 } };
    commit(docId, items.map((a) => (a.id === item.id ? next : a)), before);
  };

  const size = f.size * view.scale;
  return (
    <textarea
      ref={ref}
      className="markup-text-editor"
      aria-label={t("markup.textEditor")}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") ref.current?.blur();
      }}
      style={{
        left: view.panX + b.x * view.scale,
        top: view.panY + b.y * view.scale,
        width: Math.max(b.w * view.scale, size * 4),
        height: Math.max(b.h, (value.split("\n").length) * f.size * 1.25) * view.scale + 4,
        font: cssFont({ ...f, size }),
        color: f.color,
        textAlign: f.align,
        textDecoration: f.underline ? "underline" : undefined,
      }}
    />
  );
}
