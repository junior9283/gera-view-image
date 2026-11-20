import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { applyOp, decodeViewBuffer, renderView } from "./commands";

function buffer(w: number, h: number): ArrayBuffer {
  const buf = new ArrayBuffer(8 + w * h * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, w, true);
  dv.setUint32(4, h, true);
  new Uint8Array(buf, 8).fill(7);
  return buf;
}

describe("decodeViewBuffer", () => {
  it("lê largura e altura em little-endian e o RGBA depois do cabeçalho", () => {
    const v = decodeViewBuffer(buffer(300, 2));
    expect(v.width).toBe(300);
    expect(v.height).toBe(2);
    expect(v.data).toBeInstanceOf(Uint8ClampedArray);
    expect(v.data.length).toBe(300 * 2 * 4);
    expect(v.data[0]).toBe(7);
  });

  it("aceita Uint8Array com deslocamento", () => {
    const raw = new Uint8Array(buffer(1, 1));
    const shifted = new Uint8Array(raw.length + 3);
    shifted.set(raw, 3);
    const v = decodeViewBuffer(shifted.subarray(3));
    expect([v.width, v.height, v.data.length]).toEqual([1, 1, 4]);
  });

  it("rejeita buffer menor que o cabeçalho declara", () => {
    const b = buffer(2, 2).slice(0, 12);
    expect(() => decodeViewBuffer(b)).toThrow();
  });
});

describe("wrappers", () => {
  beforeEach(() => invoke.mockReset());

  it("renderView chama render_view com argumentos camelCase e decodifica", async () => {
    invoke.mockResolvedValue(buffer(4, 3));
    const v = await renderView(1, 0, 800, 600);
    expect(invoke).toHaveBeenCalledWith("render_view", { id: 1, frame: 0, maxW: 800, maxH: 600, region: null });
    expect([v.width, v.height]).toEqual([4, 3]);
  });

  it("applyOp envia a operação no formato { type, data }", async () => {
    invoke.mockResolvedValue({});
    await applyOp(2, { type: "rotate", data: { quarterTurns: 1 } });
    expect(invoke).toHaveBeenCalledWith("apply_op", { id: 2, op: { type: "rotate", data: { quarterTurns: 1 } } });
  });
});
