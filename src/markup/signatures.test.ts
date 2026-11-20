import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ data: new Map<string, unknown>(), saves: 0, file: "" }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async (file: string) => {
    disk.file = file;
    return {
      get: async (k: string) => disk.data.get(k),
      set: async (k: string, v: unknown) => void disk.data.set(k, v),
      save: async () => void disk.saves++,
    };
  }),
}));

import {
  MAX_SIGNATURES,
  addSignature,
  alphaBounds,
  catmullRom,
  clearMask,
  getSignatures,
  lightCorners,
  loadSignatures,
  removeSignature,
  resetSignaturesForTests,
} from "./signatures";

beforeEach(() => {
  disk.data.clear();
  disk.saves = 0;
  resetSignaturesForTests();
});

describe("assinaturas salvas", () => {
  it("ficam em signatures.json, a mais nova primeiro, no máximo 10", async () => {
    await loadSignatures();
    for (let i = 0; i < 12; i++) await addSignature(`png${i}`);
    expect(disk.file).toBe("signatures.json");
    const list = getSignatures();
    expect(list).toHaveLength(MAX_SIGNATURES);
    expect(list[0].png).toBe("png11");
    expect((disk.data.get("signatures") as unknown[]).length).toBe(10);
    expect(disk.saves).toBeGreaterThan(0);
  });

  it("carrega do disco descartando entradas inválidas e remove", async () => {
    disk.data.set("signatures", [{ id: "a", png: "AAA" }, { id: 3 }, "x", { id: "b", png: "BBB" }]);
    expect((await loadSignatures()).map((s) => s.id)).toEqual(["a", "b"]);
    await removeSignature("a");
    expect(getSignatures().map((s) => s.id)).toEqual(["b"]);
    expect(disk.data.get("signatures")).toEqual([{ id: "b", png: "BBB" }]);
  });
});

describe("desenho suavizado (Catmull-Rom)", () => {
  it("passa pelos pontos de controle e interpola entre eles", () => {
    const pts: [number, number][] = [[0, 0], [10, 10], [20, 0], [30, 10]];
    const out = catmullRom(pts, 4);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([30, 10]);
    expect(out).toContainEqual([10, 10]);
    expect(out).toContainEqual([20, 0]);
    expect(out.length).toBe(3 * 4 + 1);
  });

  it("com menos de 3 pontos devolve os mesmos pontos", () => {
    expect(catmullRom([[1, 2], [3, 4]], 8)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("importar assinatura (fundo claro)", () => {
  // 4x3: fundo branco e um traço preto em (1,1) e (2,1).
  const img = () => {
    const d = new Uint8ClampedArray(4 * 3 * 4).fill(255);
    for (const i of [5, 6]) d.set([0, 0, 0, 255], i * 4);
    return d;
  };

  it("acha os cantos claros para semear o Alfa Instantâneo", () => {
    const d = img();
    d.set([10, 10, 10, 255], (2 * 4 + 3) * 4); // canto inferior direito escuro
    expect(lightCorners(d, 4, 3)).toEqual([[0, 0], [3, 0], [0, 2]]);
  });

  it("zera o alfa da máscara e recorta no que sobrou", () => {
    const d = img();
    const cov = new Uint8Array(12).fill(1);
    cov[5] = cov[6] = 0;
    clearMask(d, cov);
    expect(d[3]).toBe(0);
    expect(d[5 * 4 + 3]).toBe(255);
    expect(alphaBounds(d, 4, 3)).toEqual({ x: 1, y: 1, w: 2, h: 1 });
    expect(alphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});
