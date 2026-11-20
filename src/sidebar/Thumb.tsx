import { useEffect, useRef, useState } from "react";
import { thumbnail } from "../ipc/commands";
import type { DocInfo, ViewBuffer } from "../ipc/types";
import { ErrorIcon } from "../viewer/DocError";
import { bufferToCanvas, dpr } from "../viewer/paint";

/** Miniaturas recentes (LRU pela ordem de inserção do Map). */
const cache = new Map<string, Promise<ViewBuffer>>();
const CACHE_MAX = 150;

function load(key: string, get: () => Promise<ViewBuffer>): Promise<ViewBuffer> {
  let p = cache.get(key);
  if (p) cache.delete(key);
  else {
    p = get();
    p.catch(() => cache.delete(key));
  }
  cache.set(key, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

interface Props {
  doc: DocInfo;
  frame?: number;
  /** Lado máximo exibido, em px CSS. */
  size: number;
  /** Lado pedido ao Rust (px CSS, antes do devicePixelRatio); padrão = `size`. */
  fetchSize?: number;
}

/** Miniatura sob demanda: só pede `thumbnail` quando entra na área visível. */
export function Thumb({ doc, frame = 0, size, fetchSize = size }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { id, rev, error } = doc;
  useEffect(() => {
    if (!visible || error) return;
    const px = Math.round(fetchSize * dpr());
    let alive = true;
    load(`${id}:${rev}:${frame}:${px}`, () => thumbnail(id, frame, px))
      .then((v) => alive && canvas.current && bufferToCanvas(v, canvas.current))
      .catch((e) => console.error("falha na miniatura:", e));
    return () => {
      alive = false;
    };
  }, [visible, id, rev, error, frame, fetchSize]);

  return (
    <div ref={box} className={`thumb${error ? " thumb-error" : ""}`} data-testid={error ? "thumb-error" : undefined} style={{ width: size, height: size }}>
      {error ? <ErrorIcon size={Math.round(size / 2)} /> : <canvas ref={canvas} />}
    </div>
  );
}
