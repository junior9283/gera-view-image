import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { fitView, zoomAt, type View } from "./transform";
import { renderView, startupDocuments } from "../ipc/commands";
import { DOC_UPDATED_EVENT, type DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";

/**
 * Viewport mínimo: mostra o primeiro documento de `argv` via `render_view`, com zoom
 * Ctrl+roda e pan por arraste. A versão completa (navegação, erros, região) é da Tarefa 5.
 */
export function Viewport() {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = box.current!;
    const cv = canvas.current!;
    let view: View = { scale: 1, x: 0, y: 0 };
    let drag: { x: number; y: number } | null = null;
    let shown: DocInfo | null = null;

    const apply = () => {
      cv.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    };

    // Desenha o buffer ajustado à janela em pixels físicos (1 px do canvas = 1/dpr px CSS).
    const draw = async (info: DocInfo) => {
      if (info.error) return;
      const dpr = window.devicePixelRatio || 1;
      const v = await renderView(info.id, 0, Math.round(el.clientWidth * dpr), Math.round(el.clientHeight * dpr));
      cv.width = v.width;
      cv.height = v.height;
      cv.getContext("2d")!.putImageData(new ImageData(v.data, v.width, v.height), 0, 0);
      cv.style.width = `${v.width / dpr}px`;
      cv.style.height = `${v.height / dpr}px`;
      if (shown?.id !== info.id) {
        view = fitView(v.width / dpr, v.height / dpr, el.clientWidth, el.clientHeight);
        apply();
      }
      shown = info;
    };

    const start = async () => {
      const infos = await startupDocuments();
      useDocs.getState().add(infos);
      const first = infos.find((d) => !d.error) ?? infos[0];
      if (first) await draw(first);
    };
    start().catch((e) => console.error("falha ao abrir imagem:", e));

    // A decodificação completa (ou outra mudança feita no Rust) chega por evento.
    const unlisten = listen<DocInfo>(DOC_UPDATED_EVENT, (e) => {
      useDocs.getState().update(e.payload);
      if (shown?.id === e.payload.id) draw(e.payload).catch((err) => console.error(err));
    });

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      apply();
    };
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      view = { ...view, x: view.x + e.clientX - drag.x, y: view.y + e.clientY - drag.y };
      drag = { x: e.clientX, y: e.clientY };
      apply();
    };
    const onUp = () => (drag = null);

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    return () => {
      unlisten.then((f) => f());
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <div ref={box} className="viewport">
      <canvas ref={canvas} className="viewport-canvas" />
    </div>
  );
}
