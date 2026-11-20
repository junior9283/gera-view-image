import { describe, expect, it } from "vitest";
import { RESIZE_PRESETS, fromPixels, linkDims, toPixels } from "./units";

describe("units", () => {
  it("converte para pixels", () => {
    expect(toPixels(2.54, "cm", 300, 0)).toBe(300);
    expect(toPixels(50, "%", 72, 1000)).toBe(500);
    expect(toPixels(25.4, "mm", 150, 0)).toBe(150);
    expect(toPixels(640, "px", 72, 0)).toBe(640);
  });

  it("converte de pixels", () => {
    expect(fromPixels(300, "in", 150, 0)).toBe(2);
    expect(fromPixels(500, "%", 72, 1000)).toBe(50);
    expect(fromPixels(300, "cm", 300, 0)).toBeCloseTo(2.54, 10);
  });

  it("proporcional mantém razão", () => {
    const orig = { w: 4000, h: 3000 };
    expect(linkDims(orig, "w", 1000)).toEqual({ w: 1000, h: 750 });
    expect(linkDims(orig, "h", 600)).toEqual({ w: 800, h: 600 });
    expect(linkDims(orig, "w", 0)).toEqual({ w: 1, h: 1 });
  });

  it("tem os presets pedidos", () => {
    expect(RESIZE_PRESETS).toHaveLength(7);
    expect(RESIZE_PRESETS[0]).toEqual({ w: 320, h: 240 });
    expect(RESIZE_PRESETS[6]).toEqual({ w: 3840, h: 2160 });
  });
});
