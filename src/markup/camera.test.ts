import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const cameraAllow = vi.fn(async (allowed: boolean) => {
  calls.push(`allow:${allowed}`);
});
vi.mock("../ipc/commands", () => ({ cameraAllow: (a: boolean) => cameraAllow(a) }));

import { CameraError, classifyCameraError, inkBounds, inkPixels, otsuThreshold, startCamera } from "./camera";

/** Câmera falsa: os testes NUNCA tocam a câmera real. */
function fakeStream() {
  const track = { stop: vi.fn(() => calls.push("track.stop")), addEventListener: vi.fn() };
  return { stream: { getTracks: () => [track, track] } as unknown as MediaStream, track };
}

function setMediaDevices(md: unknown) {
  Object.defineProperty(navigator, "mediaDevices", { value: md, configurable: true });
}

describe("câmera da assinatura", () => {
  beforeEach(() => {
    calls.length = 0;
    cameraAllow.mockClear();
  });
  afterEach(() => setMediaDevices(undefined));

  it("arma ANTES de pedir a câmera, pede só vídeo e desliga tudo ao parar (uma vez só)", async () => {
    const { stream, track } = fakeStream();
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      calls.push("getUserMedia");
      expect(c.audio).toBe(false);
      expect(c.video).toBeTruthy();
      return stream;
    });
    setMediaDevices({ getUserMedia });
    const cam = await startCamera();
    expect(calls).toEqual(["allow:true", "getUserMedia"]);
    await cam.stop();
    await cam.stop();
    expect(track.stop).toHaveBeenCalledTimes(2); // uma por trilha, só na primeira chamada
    expect(calls.slice(2)).toEqual(["track.stop", "track.stop", "allow:false"]);
  });

  it("sem permissão: desarma e mostra erro claro", async () => {
    setMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" })) });
    await expect(startCamera()).rejects.toMatchObject({ code: "denied" });
    expect(calls).toEqual(["allow:true", "allow:false"]);
  });

  it("sem câmera conectada", async () => {
    setMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "NotFoundError" })) });
    await expect(startCamera()).rejects.toBeInstanceOf(CameraError);
    expect(calls[calls.length - 1]).toBe("allow:false");
  });

  it("webview sem suporte a mídia", async () => {
    setMediaDevices(undefined);
    await expect(startCamera()).rejects.toMatchObject({ code: "unsupported" });
    expect(calls).toEqual(["allow:true", "allow:false"]);
  });

  it("se o Rust não consegue armar, nem tenta ligar a câmera", async () => {
    const getUserMedia = vi.fn();
    setMediaDevices({ getUserMedia });
    cameraAllow.mockRejectedValueOnce(new Error("sem janela"));
    await expect(startCamera()).rejects.toMatchObject({ code: "unsupported" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("sessão antiga que para depois não desarma o consentimento da nova", async () => {
    const stream = () => ({ getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }] }) as unknown as MediaStream;
    setMediaDevices({ getUserMedia: vi.fn().mockResolvedValueOnce(stream()).mockResolvedValueOnce(stream()) });
    const a = await startCamera();
    const b = await startCamera();
    calls.length = 0;
    await a.stop();
    expect(calls).not.toContain("allow:false");
    await b.stop();
    expect(calls).toContain("allow:false");
  });

  it("avisa quando a trilha termina (webcam desconectada)", async () => {
    let onEnd: () => void = () => {};
    const track = { stop: vi.fn(), addEventListener: (_: string, f: () => void) => (onEnd = f) };
    setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) });
    const ended = vi.fn();
    await startCamera(ended);
    onEnd();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("classifica os erros do getUserMedia", () => {
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyCameraError({ name: "OverconstrainedError" })).toBe("notFound");
    expect(classifyCameraError({ name: "Outro" })).toBe("failed");
    expect(classifyCameraError(null)).toBe("failed");
  });
});

/** Quadro cinza `w`×`h` com `fn(x, y)` de tom em cada pixel. */
function frame(w: number, h: number, fn: (x: number, y: number) => number) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) d.set([fn(x, y), fn(x, y), fn(x, y), 255], (y * w + x) * 4);
  return d;
}

describe("tinta a partir do quadro", () => {
  const W = 40;
  const H = 20;
  // Papel claro (220) com um traço escuro (30) em x 10..29, y 8..10.
  const paper = frame(W, H, (x, y) => (x >= 10 && x < 30 && y >= 8 && y <= 10 ? 30 : 220));

  it("Otsu separa a tinta do papel", () => {
    const t = otsuThreshold(paper);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });

  it("só o traço vira tinta; o papel fica transparente", () => {
    const ink = inkPixels(paper, otsuThreshold(paper));
    const alpha = (x: number, y: number) => ink[(y * W + x) * 4 + 3];
    expect(alpha(15, 9)).toBe(255);
    expect(alpha(2, 2)).toBe(0);
    expect(alpha(15, 2)).toBe(0);
  });

  it("recorta na tinta com margem e ignora ruído fraco", () => {
    const ink = inkPixels(paper, otsuThreshold(paper));
    expect(inkBounds(ink, W, H, 2)).toEqual({ x: 8, y: 6, w: 24, h: 7 });
    // um pixel de ruído fraco (alfa baixo) longe do traço não aumenta a caixa
    ink[(1 * W + 1) * 4 + 3] = 40;
    expect(inkBounds(ink, W, H, 2)).toEqual({ x: 8, y: 6, w: 24, h: 7 });
  });

  it("quadro em branco não tem assinatura", () => {
    const blank = frame(W, H, () => 230);
    expect(inkBounds(inkPixels(blank, otsuThreshold(blank)), W, H)).toBeNull();
  });
});
