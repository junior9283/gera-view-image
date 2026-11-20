import { describe, expect, it } from "vitest";
import { recognize } from "./sketch";
import type { Point } from "./model";

/** Gerador determinístico (mulberry32) para o rabisco aleatório. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pontos ao longo de uma poligonal, `n` por segmento. */
function along(vertices: Point[], n = 16): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const [a, b] = [vertices[i], vertices[i + 1]];
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(vertices[vertices.length - 1]);
  return out;
}

describe("recognize (esboço)", () => {
  it("traço circular de 64 pontos vira oval", () => {
    const pts: Point[] = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 63) * Math.PI * 2;
      return [200 + 80 * Math.cos(a), 150 + 50 * Math.sin(a)];
    });
    const r = recognize(pts);
    expect(r?.kind).toBe("oval");
    const g = r!.geom as { x: number; y: number; w: number; h: number };
    expect(g.x).toBeCloseTo(120, 0);
    expect(g.w).toBeCloseTo(160, 0);
    expect(g.h).toBeCloseTo(100, 0);
  });

  it("quatro segmentos retos fechados viram rect", () => {
    const pts = along([[10, 10], [110, 10], [110, 70], [10, 70], [10, 11]]);
    const r = recognize(pts);
    expect(r?.kind).toBe("rect");
    expect(r!.geom).toMatchObject({ x: 10, y: 10, w: 100, h: 60 });
  });

  it("linha quase reta vira line", () => {
    const pts: Point[] = Array.from({ length: 30 }, (_, i) => [i * 5, 20 + Math.sin(i) * 0.8]);
    const r = recognize(pts);
    expect(r?.kind).toBe("line");
    expect(r!.geom).toMatchObject({ x1: 0, x2: 145 });
  });

  it("linha reta com um V na ponta vira arrow", () => {
    const pts = along([[0, 0], [100, 0], [85, -12], [100, 0], [85, 12]], 10);
    const r = recognize(pts);
    expect(r?.kind).toBe("arrow");
    expect(r!.geom).toEqual({ x1: 0, y1: 0, x2: 100, y2: 0 });
  });

  it("rabisco aleatório (seed fixa) não é reconhecido", () => {
    const rand = rng(42);
    const pts: Point[] = Array.from({ length: 40 }, () => [rand() * 200, rand() * 200]);
    expect(recognize(pts)).toBeNull();
  });

  it("estrela de 5 pontas", () => {
    const v: Point[] = Array.from({ length: 11 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 40 : 100;
      return [200 + r * Math.cos(a), 200 + r * Math.sin(a)];
    });
    const r = recognize(along(v, 8));
    expect(r?.kind).toBe("star");
    expect((r!.geom as { points: number }).points).toBe(5);
  });

  it("oval com cauda vira balão", () => {
    const body: Point[] = Array.from({ length: 60 }, (_, i) => {
      const a = Math.PI / 2 + 0.35 + (i / 59) * (Math.PI * 2 - 0.7);
      return [200 + 100 * Math.cos(a), 100 + 60 * Math.sin(a)];
    });
    // Cauda: do fim do contorno até a ponta e de volta ao começo.
    const tip: Point = [170, 240];
    const pts = [...body, ...along([body[body.length - 1], tip, body[0]], 8)];
    const r = recognize(pts);
    expect(r?.kind).toBe("bubble");
    const g = r!.geom as { tail: { x: number; y: number } };
    expect(g.tail.x).toBeCloseTo(170, 0);
    expect(g.tail.y).toBeCloseTo(240, 0);
  });

  it("menos de 3 pontos não é reconhecido", () => {
    expect(recognize([[0, 0], [1, 1]])).toBeNull();
  });
});
