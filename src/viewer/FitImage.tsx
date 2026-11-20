import { useEffect, useRef, useState } from "react";
import { renderView } from "../ipc/commands";
import type { DocInfo } from "../ipc/types";
import { DocError } from "./DocError";
import { bufferToCanvas, useAnimatedFrame } from "./paint";

/** Imagem ajustada (sem ampliar) e centralizada na caixa; GIF animado toca. Usada na apresentação. */
export function FitImage({ doc, className }: { doc: DocInfo; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const frame = useAnimatedFrame(doc);

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { id, rev, error } = doc;
  useEffect(() => {
    if (error || size.w <= 0 || size.h <= 0) return;
    const k = window.devicePixelRatio || 1;
    let alive = true;
    renderView(id, frame, Math.round(size.w * k), Math.round(size.h * k))
      .then((v) => {
        const cv = canvas.current;
        if (!alive || !cv) return;
        bufferToCanvas(v, cv);
        cv.style.width = `${v.width / k}px`;
        cv.style.height = `${v.height / k}px`;
      })
      .catch((e) => console.error("falha ao desenhar a imagem:", e));
    return () => {
      alive = false;
    };
  }, [id, rev, error, frame, size]);

  return (
    <div ref={box} className={`fit-image ${className ?? ""}`}>
      {error ? <DocError doc={doc} /> : <canvas ref={canvas} />}
    </div>
  );
}
