import { useEffect, useState } from "react";
import type { DocInfo, ViewBuffer } from "../ipc/types";

/** Pixels físicos por px CSS. */
export const dpr = () => window.devicePixelRatio || 1;

/** Copia o buffer RGBA do IPC para um canvas (novo ou reaproveitado). */
export function bufferToCanvas(v: ViewBuffer, canvas: HTMLCanvasElement = document.createElement("canvas")): HTMLCanvasElement {
  canvas.width = v.width;
  canvas.height = v.height;
  canvas.getContext("2d")?.putImageData(new ImageData(v.data, v.width, v.height), 0, 0);
  return canvas;
}

const patterns = new WeakMap<CanvasRenderingContext2D, { size: number; pattern: CanvasPattern | null }>();

/** Xadrez de transparência com casas de `size` px do canvas. */
export function checkerPattern(ctx: CanvasRenderingContext2D, size: number): CanvasPattern | null {
  const hit = patterns.get(ctx);
  if (hit?.size === size) return hit.pattern;
  const tile = document.createElement("canvas");
  tile.width = tile.height = size * 2;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.fillStyle = "#ffffff";
  t.fillRect(0, 0, size * 2, size * 2);
  t.fillStyle = "#cccccc";
  t.fillRect(0, 0, size, size);
  t.fillRect(size, size, size, size);
  const pattern = ctx.createPattern(tile, "repeat");
  patterns.set(ctx, { size, pattern });
  return pattern;
}

/** O formato não traz a duração dos quadros; 100 ms é o padrão usual dos navegadores. */
export const GIF_FRAME_MS = 100;

export const isAnimated = (d: DocInfo | null | undefined): boolean => !!d && d.format === "gif" && d.frames > 1 && !d.error;

/** Quadro atual de um GIF animado (0 para o resto). Reinicia ao trocar de documento. */
export function useAnimatedFrame(doc: DocInfo | null | undefined, playing = true): number {
  const animated = playing && isAnimated(doc);
  const frames = doc?.frames ?? 1;
  const id = doc?.id;
  const [state, setState] = useState({ id, frame: 0 });
  useEffect(() => {
    if (!animated) return;
    const t = setInterval(() => setState((s) => ({ id, frame: s.id === id ? (s.frame + 1) % frames : 1 % frames })), GIF_FRAME_MS);
    return () => clearInterval(t);
  }, [animated, frames, id]);
  return animated && state.id === id ? state.frame % frames : 0;
}
