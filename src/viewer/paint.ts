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

/**
 * Pinta `b` em `dest` (px CSS) num canvas do tamanho da área `size`, com o xadrez atrás da
 * transparência se `checker` (Visualizar › Mostrar Fundo da Imagem). `null` só limpa.
 */
export function paintBuffer(
  cv: HTMLCanvasElement,
  size: { w: number; h: number },
  b: { canvas: HTMLCanvasElement; dest: { x: number; y: number; w: number; h: number } } | null,
  checker: boolean,
): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const k = dpr();
  const w = Math.round(size.w * k);
  const h = Math.round(size.h * k);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!b) return;
  const { dest } = b;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (checker) {
    ctx.fillStyle = checkerPattern(ctx, 8) ?? "#fff";
    ctx.fillRect(dest.x, dest.y, dest.w, dest.h);
  }
  // Ampliação forte: pixels nítidos; o resto suavizado.
  ctx.imageSmoothingEnabled = (dest.w * k) / b.canvas.width < 2;
  ctx.drawImage(b.canvas, dest.x, dest.y, dest.w, dest.h);
}

/** Atraso de quem ainda não manda `delaysMs` (contrato antigo); o núcleo já normaliza os demais. */
const DEFAULT_FRAME_MS = 100;

export const isAnimated = (d: DocInfo | null | undefined): boolean =>
  !!d && (d.format === "gif" || d.format === "webp") && d.frames > 1 && !d.error;

/**
 * Quadro atual de uma animação (0 para o resto), com o atraso de cada quadro do arquivo e as
 * repetições declaradas (`plays`; 0 = para sempre). Reinicia ao trocar de documento.
 */
export function useAnimatedFrame(doc: DocInfo | null | undefined, playing = true): number {
  const animated = playing && isAnimated(doc);
  const frames = doc?.frames ?? 1;
  const id = doc?.id;
  // Chave estável: o `DocInfo` chega novo a cada revisão e não deve reiniciar a animação.
  const delayKey = doc?.delaysMs?.join(",") ?? "";
  const plays = doc?.plays ?? 0;
  const [state, setState] = useState({ id, frame: 0 });
  useEffect(() => {
    if (!animated) return;
    const delays = delayKey ? delayKey.split(",").map(Number) : [];
    let frame = 0;
    let loop = 1;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (frame + 1 < frames) frame++;
        else if (plays === 0 || loop < plays) [frame, loop] = [0, loop + 1];
        else return; // acabaram as repetições: fica no último quadro
        setState({ id, frame });
        schedule();
      }, delays[frame] ?? DEFAULT_FRAME_MS);
    };
    schedule(); // troca de documento: o retorno abaixo já mostra o quadro 0 até o 1º tique
    return () => clearTimeout(timer);
  }, [animated, frames, id, delayKey, plays]);
  return animated && state.id === id ? state.frame % frames : 0;
}
