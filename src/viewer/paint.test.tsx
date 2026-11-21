import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";
import { isAnimated, useAnimatedFrame } from "./paint";

const gif = (extra: Partial<DocInfo> = {}): DocInfo => ({
  id: 1, path: "/p/a.gif", name: "a.gif", format: "gif", width: 10, height: 10, frames: 3,
  writable: false, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useAnimatedFrame", () => {
  it("agenda cada quadro com o atraso recebido do núcleo", () => {
    const { result } = renderHook(() => useAnimatedFrame(gif({ delaysMs: [30, 200, 50], plays: 0 })));
    expect(result.current).toBe(0);
    advance(29);
    expect(result.current).toBe(0);
    advance(1);
    expect(result.current).toBe(1);
    advance(199);
    expect(result.current).toBe(1);
    advance(1);
    expect(result.current).toBe(2);
    advance(50);
    expect(result.current).toBe(0); // para sempre: volta ao início
  });

  it("para no último quadro depois das repetições declaradas", () => {
    const { result } = renderHook(() => useAnimatedFrame(gif({ frames: 2, delaysMs: [40, 60], plays: 2 })));
    advance(40 + 60 + 40);
    expect(result.current).toBe(1); // segunda volta, último quadro
    advance(10_000);
    expect(result.current).toBe(1);
  });

  it("sem atrasos no contrato antigo usa 100 ms", () => {
    const { result } = renderHook(() => useAnimatedFrame(gif()));
    advance(99);
    expect(result.current).toBe(0);
    advance(1);
    expect(result.current).toBe(1);
  });

  it("WebP animado também toca", () => {
    expect(isAnimated(gif({ format: "webp" }))).toBe(true);
    expect(isAnimated(gif({ format: "tiff" }))).toBe(false);
  });
});
