import { useEffect, useRef, useState } from "react";
import { thumbnail } from "../ipc/commands";
import type { DocInfo, ViewBuffer } from "../ipc/types";
import { ErrorIcon } from "../viewer/DocError";
import { bufferToCanvas, dpr } from "../viewer/paint";
import { observeVisible } from "../lib/visibility";
import { ByteLru } from "../lib/byteLru";

/** Orçamento das miniaturas já recebidas (RGBA), em bytes. */
export const THUMB_CACHE_BYTES = 96 * 1024 * 1024;
export const thumbCache = new ByteLru<string, ViewBuffer>(THUMB_CACHE_BYTES, (v) => v.data.byteLength);
const inflight = new Map<string, Promise<ViewBuffer>>();

function load(key: string, get: () => Promise<ViewBuffer>): Promise<ViewBuffer> {
  const hit = thumbCache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = get()
      .then((v) => (thumbCache.set(key, v), v))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
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

/**
 * Miniatura sob demanda: só pede `thumbnail` quando está na área visível e libera o canvas
 * (0×0) quando sai dela; ao voltar, redesenha do cache.
 */
export function Thumb({ doc, frame = 0, size, fetchSize = size }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    return observeVisible(el, setVisible);
  }, []);

  const { id, rev, error } = doc;
  useEffect(() => {
    if (error) return;
    if (!visible) {
      if (canvas.current) canvas.current.width = canvas.current.height = 0;
      return;
    }
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
