import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { Thumb, THUMB_CACHE_BYTES, thumbCache } from "./Thumb";

const info = (id: number): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
});

/** Buffer 2x1 no formato do IPC. */
const buf = () => new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 255, 4, 5, 6, 255]).buffer;

let observers: { cb: IntersectionObserverCallback; el: Element | null; disconnected: boolean }[] = [];
const fire = (visible: boolean) =>
  act(async () => {
    for (const o of observers.filter((x) => !x.disconnected && x.el))
      o.cb([{ isIntersecting: visible, target: o.el! } as IntersectionObserverEntry], {} as IntersectionObserver);
    await new Promise((r) => setTimeout(r, 0));
  });

beforeAll(() => {
  class IO {
    rec: (typeof observers)[number];
    constructor(cb: IntersectionObserverCallback) {
      this.rec = { cb, el: null, disconnected: false };
      observers.push(this.rec);
    }
    observe(el: Element) {
      this.rec.el = el;
    }
    unobserve() {}
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  vi.stubGlobal("IntersectionObserver", IO);
  // jsdom não tem canvas 2D; putImageData vira no-op.
  HTMLCanvasElement.prototype.getContext = (() => ({ putImageData() {} })) as unknown as HTMLCanvasElement["getContext"];
});

beforeEach(() => {
  observers = [];
  thumbCache.clear();
  invoke.mockReset();
  invoke.mockImplementation(async () => buf());
});
afterEach(cleanup);

describe("Thumb", () => {
  it("o orçamento do cache é em bytes (96 MB)", () => {
    expect(THUMB_CACHE_BYTES).toBe(96 * 1024 * 1024);
  });

  it("libera o canvas quando sai da tela e redesenha quando volta (do cache)", async () => {
    const { container } = render(<Thumb doc={info(1)} size={64} />);
    const canvas = () => container.querySelector("canvas")!;
    await fire(true);
    expect(canvas().width).toBe(2);
    await fire(false);
    expect(canvas().width).toBe(0);
    expect(canvas().height).toBe(0);
    await fire(true);
    expect(canvas().width).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
