import { beforeEach, describe, expect, it, vi } from "vitest";

const systemFonts = vi.fn();
vi.mock("../ipc/commands", () => ({ systemFonts: () => systemFonts() }));

import { cssFamily, cssFont } from "./fontCss";
import { loadSystemFonts, resetFontsForTests } from "./fonts";

describe("cssFamily", () => {
  it("genéricas ficam sem aspas; o resto vai entre aspas", () => {
    expect(cssFamily("sans-serif")).toBe("sans-serif");
    expect(cssFamily("Monospace")).toBe("monospace");
    expect(cssFamily("Noto Sans")).toBe('"Noto Sans"');
    expect(cssFamily("3270 Nerd Font")).toBe('"3270 Nerd Font"');
  });

  it("nome hostil não escapa das aspas nem injeta declaração", () => {
    expect(cssFamily('A"; color: red; x:"')).toBe('"A; color: red; x:"');
    expect(cssFamily("A\\\"B\nC")).toBe('"ABC"');
    expect(cssFamily('"\\')).toBe("sans-serif");
  });

  it("monta o valor de font com a reserva sans-serif", () => {
    expect(cssFont({ family: "Fira Code", size: 20, bold: true, italic: true })).toBe('italic bold 20px "Fira Code", sans-serif');
  });
});

describe("loadSystemFonts", () => {
  beforeEach(() => {
    resetFontsForTests();
    systemFonts.mockReset();
  });

  it("chama o Rust uma vez só", async () => {
    systemFonts.mockResolvedValue(["A", "B"]);
    expect(await loadSystemFonts()).toEqual(["A", "B"]);
    await loadSystemFonts();
    expect(systemFonts).toHaveBeenCalledTimes(1);
  });

  it("depois de uma falha tenta de novo", async () => {
    systemFonts.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(["C"]);
    await expect(loadSystemFonts()).rejects.toThrow();
    await Promise.resolve();
    expect(await loadSystemFonts()).toEqual(["C"]);
  });
});
