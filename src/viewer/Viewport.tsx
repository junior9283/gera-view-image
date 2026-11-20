import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fitView, zoomAt, type View } from "./transform";

/** Viewport mínimo (Tarefa 0): desenha o buffer de `render_view`, zoom Ctrl+roda e pan por arraste. */
export function Viewport() {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = box.current!;
    const cv = canvas.current!;
    let view: View = { scale: 1, x: 0, y: 0 };
    let drag: { x: number; y: number } | null = null;

    const apply = () => {
      cv.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    };

    const load = async () => {
      const dpr = window.devicePixelRatio || 1;
      const buf = await invoke<ArrayBuffer>("render_view", {
        maxW: Math.round(el.clientWidth * dpr),
        maxH: Math.round(el.clientHeight * dpr),
      });
      const [w, h] = new Uint32Array(buf.slice(0, 8));
      const data = new Uint8ClampedArray(buf, 8, w * h * 4);
      cv.width = w;
      cv.height = h;
      cv.getContext("2d")!.putImageData(new ImageData(data, w, h), 0, 0);
      // O buffer já vem ajustado à janela em pixels físicos: 1 px do canvas = 1/dpr px CSS.
      cv.style.width = `${w / dpr}px`;
      cv.style.height = `${h / dpr}px`;
      view = fitView(w / dpr, h / dpr, el.clientWidth, el.clientHeight);
      apply();
      await invoke("mark_shown");
    };
    load().catch((e) => console.error("falha ao abrir imagem:", e));

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
