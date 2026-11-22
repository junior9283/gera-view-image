// Assinatura pela câmera (papel assinado diante da webcam).
//
// Privacidade: a câmera só liga por ação explícita (o painel pede consentimento antes de
// chamar `startCamera`), nunca grava vídeo nem foto: o quadro capturado é transformado em tinta
// preta sobre fundo transparente e só essa assinatura é guardada. `stop()` desliga a câmera e
// desarma a permissão no Rust.
import * as ipc from "../ipc/commands";
import { alphaBounds } from "./signatures";
import type { Box } from "./model";

export type CameraErrorCode = "unsupported" | "denied" | "notFound" | "busy" | "failed";

export class CameraError extends Error {
  constructor(readonly code: CameraErrorCode, readonly detail?: unknown) {
    super(`camera: ${code}`);
  }
}

/** Erro do `getUserMedia` → código que a interface traduz. */
export function classifyCameraError(e: unknown): CameraErrorCode {
  switch ((e as { name?: string } | null)?.name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return "notFound";
    case "NotReadableError":
    case "AbortError":
    case "TrackStartError":
      return "busy";
    case "TypeError":
      return "unsupported";
    default:
      return "failed";
  }
}

export interface CameraSession {
  stream: MediaStream;
  /** Desliga a câmera (todas as trilhas) e desarma a permissão. Pode ser chamado mais de uma vez. */
  stop(): Promise<void>;
}

/**
 * Liga a câmera (só vídeo, nunca áudio). Precisa ser chamada logo depois do clique de
 * consentimento do usuário. Sem câmera, sem permissão ou sem suporte lança `CameraError`.
 */
export async function startCamera(): Promise<CameraSession> {
  try {
    await ipc.cameraAllow(true);
  } catch (e) {
    throw new CameraError("unsupported", e);
  }
  const disarm = () => ipc.cameraAllow(false).catch(() => {});
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) {
    await disarm();
    throw new CameraError("unsupported");
  }
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    await disarm();
    throw new CameraError(classifyCameraError(e), e);
  }
  let stopped = false;
  return {
    stream,
    async stop() {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      await disarm();
    },
  };
}

// ---- tinta a partir do quadro ----

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Limiar (0–255) pelo método de Otsu dos tons de cinza: separa a tinta (escura) do papel (claro). */
export function otsuThreshold(d: Uint8ClampedArray): number {
  const hist = new Array<number>(256).fill(0);
  const total = d.length / 4;
  for (let i = 0; i < d.length; i += 4) hist[Math.round(luma(d, i))]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let [wB, sumB, best, threshold] = [0, 0, -1, 128];
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const diff = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * diff * diff;
    if (between > best) {
      best = between;
      // Ponto médio das médias das duas classes: a tinta fica bem abaixo e o papel bem acima.
      threshold = Math.round((sumB / wB + (sum - sumB) / wF) / 2);
    }
  }
  return threshold;
}

/** Faixa de transição (em tons) que suaviza a borda da tinta. */
const SOFT = 24;

/**
 * Vetoriza o quadro: o que é mais escuro que `threshold` vira tinta preta (com borda suave) e o
 * resto fica transparente. Devolve uma cópia; `d` não é alterada.
 */
export function inkPixels(d: Uint8ClampedArray, threshold: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = (threshold - luma(d, i)) / SOFT + 0.5;
    out[i + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  }
  return out;
}

/** Caixa da tinta com margem, ou `null` se o quadro não tem tinta. Ignora ruído isolado. */
export function inkBounds(ink: Uint8ClampedArray, w: number, h: number, pad = 6): Box | null {
  const clean = new Uint8ClampedArray(ink);
  for (let i = 3; i < clean.length; i += 4) if (clean[i] < 96) clean[i] = 0;
  const b = alphaBounds(clean, w, h);
  if (!b) return null;
  const [x, y] = [Math.max(0, b.x - pad), Math.max(0, b.y - pad)];
  return { x, y, w: Math.min(w, b.x + b.w + pad) - x, h: Math.min(h, b.y + b.h + pad) - y };
}

/** Lado maior da assinatura guardada, como nas outras origens. */
const MAX_SIDE = 800;

/**
 * Quadro (RGBA) → assinatura: PNG em base64, só com a tinta e recortado. `null` se não achou tinta.
 * `threshold` vazio usa o de Otsu.
 */
export function frameToSignature(frame: { data: Uint8ClampedArray; width: number; height: number }, threshold?: number): string | null {
  const { width: w, height: h } = frame;
  const ink = inkPixels(frame.data, threshold ?? otsuThreshold(frame.data));
  const b = inkBounds(ink, w, h);
  if (!b) return null;
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  full.getContext("2d")?.putImageData(new ImageData(ink, w, h), 0, 0);
  const k = Math.min(1, MAX_SIDE / Math.max(b.w, b.h));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(b.w * k));
  out.height = Math.max(1, Math.round(b.h * k));
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, out.width, out.height);
  const url = out.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

/** Quadro atual do vídeo como pixels RGBA (cópia; o vídeo continua sem ser gravado). */
export function grabFrame(video: HTMLVideoElement): { data: Uint8ClampedArray; width: number; height: number } | null {
  const [w, h] = [video.videoWidth, video.videoHeight];
  if (!w || !h) return null;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return { data, width: w, height: h };
}
