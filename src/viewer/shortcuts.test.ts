import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const k = (key: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}, code = "") => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("atalhos do visualizador", () => {
  it("navegação", () => {
    expect(shortcutFor(k("ArrowRight"))).toBe("next");
    expect(shortcutFor(k("PageDown"))).toBe("next");
    expect(shortcutFor(k("ArrowLeft"))).toBe("prev");
    expect(shortcutFor(k("PageUp"))).toBe("prev");
    expect(shortcutFor(k("Home"))).toBe("first");
    expect(shortcutFor(k("End"))).toBe("last");
    expect(shortcutFor(k("ArrowRight", { ctrlKey: true }))).toBeNull();
  });

  it("zoom", () => {
    expect(shortcutFor(k("0", { ctrlKey: true }))).toBe("actualSize");
    expect(shortcutFor(k("9", { ctrlKey: true }))).toBe("fitToWindow");
    expect(shortcutFor(k("=", { ctrlKey: true }))).toBe("zoomIn");
    expect(shortcutFor(k("+", { ctrlKey: true, shiftKey: true }))).toBe("zoomIn");
    expect(shortcutFor(k("-", { ctrlKey: true }))).toBe("zoomOut");
    // teclado numérico
    expect(shortcutFor(k("+", { ctrlKey: true }, "NumpadAdd"))).toBe("zoomIn");
    expect(shortcutFor(k("0"))).toBeNull();
  });

  it("tela cheia, apresentação e Esc", () => {
    expect(shortcutFor(k("F11"))).toBe("toggleFullscreen");
    expect(shortcutFor(k("f", { ctrlKey: true, metaKey: true }))).toBe("toggleFullscreen");
    expect(shortcutFor(k("F", { ctrlKey: true, shiftKey: true }))).toBe("startSlideshow");
    expect(shortcutFor(k("Escape"))).toBe("exit");
    expect(shortcutFor(k("f", { ctrlKey: true }))).toBeNull();
  });
});
