import { describe, expect, it, vi } from "vitest";
import {
  hitHandle,
  latestOnly,
  rectFromPoints,
  resizeRect,
  throttle,
  toleranceFromDistance,
  toImage,
  toScreen,
} from "./tools";

const view = { scale: 2, panX: 10, panY: 20 };

describe("coordenadas", () => {
  it("imagem e tela são inversas", () => {
    const [sx, sy] = toScreen(view, 5, 7);
    expect([sx, sy]).toEqual([20, 34]);
    expect(toImage(view, sx, sy)).toEqual([5, 7]);
  });
});

describe("retângulo por arraste", () => {
  it("normaliza, arredonda e limita à imagem", () => {
    expect(rectFromPoints([30.4, 20.2], [10.6, 5.1], 100, 100)).toEqual({ x: 11, y: 5, w: 19, h: 15 });
    expect(rectFromPoints([-10, -10], [500, 500], 100, 80)).toEqual({ x: 0, y: 0, w: 100, h: 80 });
  });

  it("com shift vira quadrado", () => {
    expect(rectFromPoints([0, 0], [30, 10], 100, 100, true)).toEqual({ x: 0, y: 0, w: 30, h: 30 });
  });
});

describe("alças", () => {
  const r = { x: 10, y: 10, w: 20, h: 20 };
  const v = { scale: 1, panX: 0, panY: 0 };

  it("acha a alça sob o cursor", () => {
    expect(hitHandle(r, v, 10, 10)).toBe("nw");
    expect(hitHandle(r, v, 30, 20)).toBe("e");
    expect(hitHandle(r, v, 20, 30)).toBe("s");
    expect(hitHandle(r, v, 200, 200)).toBeNull();
  });

  it("redimensiona pela alça sem inverter nem sair da imagem", () => {
    expect(resizeRect(r, "e", 5, 0, 100, 100)).toEqual({ x: 10, y: 10, w: 25, h: 20 });
    expect(resizeRect(r, "nw", 5, 5, 100, 100)).toEqual({ x: 15, y: 15, w: 15, h: 15 });
    expect(resizeRect(r, "w", 50, 0, 100, 100)).toEqual({ x: 29, y: 10, w: 1, h: 20 });
    expect(resizeRect(r, "se", 500, 500, 100, 100)).toEqual({ x: 10, y: 10, w: 90, h: 90 });
  });
});

describe("Alfa Instantâneo", () => {
  it("0–300 px mapeiam a tolerância 0–1", () => {
    expect(toleranceFromDistance(0)).toBe(0);
    expect(toleranceFromDistance(150)).toBe(0.5);
    expect(toleranceFromDistance(900)).toBe(1);
  });
});

describe("latestOnly", () => {
  it("nunca roda duas chamadas juntas e só repete a última pendente", async () => {
    const resolvers: (() => void)[] = [];
    let ativas = 0;
    let maxAtivas = 0;
    const fn = vi.fn((a: number) => {
      ativas++;
      maxAtivas = Math.max(maxAtivas, ativas);
      return new Promise<number>((ok) => resolvers.push(() => (ativas--, ok(a * 10))));
    });
    const done = vi.fn();
    const call = latestOnly(fn, done);
    call(1);
    call(2);
    call(3);
    expect(fn).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(fn).toHaveBeenLastCalledWith(3);
    resolvers[1]();
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2));
    expect(maxAtivas).toBe(1);
    expect(done).toHaveBeenNthCalledWith(1, 10, 1, false);
    expect(done).toHaveBeenNthCalledWith(2, 30, 3, true);
  });

  it("sobrevive a uma falha", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
    const done = vi.fn();
    const call = latestOnly(fn, done);
    call(1);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    call(2);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith("ok", 2, true));
  });
});

describe("throttle", () => {
  it("executa no início e no fim da janela, com o último argumento", () => {
    vi.useFakeTimers();
    const f = vi.fn();
    const t = throttle(f, 60);
    t(1);
    t(2);
    t(3);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(60);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenLastCalledWith(3);
    vi.useRealTimers();
  });
});
