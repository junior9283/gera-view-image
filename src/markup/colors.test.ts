import { beforeEach, describe, expect, it, vi } from "vitest";

const renderView = vi.fn();
vi.mock("../ipc/commands", () => ({ renderView: (...a: unknown[]) => renderView(...a) }));

import { MAX_RECENT_COLORS } from "../store/prefs";
import { formatColor, opacityOf, opaque, parseColor, pixelColor, pushRecent, sampleScreenColor, withOpacity } from "./colors";

describe("cores com opacidade", () => {
  it("lê e escreve #rrggbb e #rrggbbaa", () => {
    expect(parseColor("#FF8000")).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(parseColor("#ff800080")).toEqual({ r: 255, g: 128, b: 0, a: 128 });
    expect(parseColor("red")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(formatColor({ r: 255, g: 128, b: 0, a: 255 })).toBe("#ff8000");
    expect(formatColor({ r: 255, g: 128, b: 0, a: 128 })).toBe("#ff800080");
  });

  it("opacidade em porcentagem ida e volta", () => {
    expect(withOpacity("#ff0000", 50)).toBe("#ff000080");
    expect(opacityOf("#ff000080")).toBe(50);
    expect(withOpacity("#ff000080", 100)).toBe("#ff0000");
    expect(withOpacity("#ff0000", 0)).toBe("#ff000000");
    expect(withOpacity("#ff0000", 150)).toBe("#ff0000");
    expect(opacityOf("transparent")).toBe(100);
    expect(withOpacity("transparent", 40)).toBe("transparent");
  });

  it("opaque tira o alfa e protege o input de cor", () => {
    expect(opaque("#11223344")).toBe("#112233");
    expect(opaque("transparent")).toBe("#000000");
    expect(opaque("x", "#ffffff")).toBe("#ffffff");
  });
});

describe("cores recentes", () => {
  it("a nova vai para o topo, sem repetir (ignorando caixa)", () => {
    expect(pushRecent(["#111111", "#222222"], "#222222")).toEqual(["#222222", "#111111"]);
    expect(pushRecent(["#aabbcc"], "#AABBCC")).toEqual(["#aabbcc"]);
    expect(pushRecent(["#111111"], "#33333380")).toEqual(["#33333380", "#111111"]);
  });

  it("limita o tamanho e ignora cor inválida", () => {
    const cheia = Array.from({ length: MAX_RECENT_COLORS }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    const r = pushRecent(cheia, "#ffffff");
    expect(r).toHaveLength(MAX_RECENT_COLORS);
    expect(r[0]).toBe("#ffffff");
    expect(pushRecent(["#111111"], "azul")).toEqual(["#111111"]);
  });
});

describe("conta-gotas", () => {
  beforeEach(() => renderView.mockReset());

  it("pixel transparente não escolhe cor", () => {
    expect(pixelColor([10, 20, 30, 0])).toBeNull();
    expect(pixelColor([10, 20, 30, 255])).toBe("#0a141e");
  });

  it("lê o pixel já em cor de tela pelo renderView, 1×1, dentro da imagem", async () => {
    renderView.mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255]) });
    expect(await sampleScreenColor(7, 3.9, 4.2, 10, 10)).toBe("#c86432");
    expect(renderView).toHaveBeenCalledWith(7, 0, 1, 1, { x: 3, y: 4, w: 1, h: 1 });
    await sampleScreenColor(7, 99, -5, 10, 10);
    expect(renderView).toHaveBeenLastCalledWith(7, 0, 1, 1, { x: 9, y: 0, w: 1, h: 1 });
  });
});
