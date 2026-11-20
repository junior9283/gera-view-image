import { describe, expect, it } from "vitest";
import { ALIASES, KEYMAP, comboOf, formatShortcut, matchShortcut } from "./keymap";

type Mods = Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>>;
const key = (k: string, mods: Mods = {}, code = "", target?: EventTarget) => {
  const e = new KeyboardEvent("keydown", { key: k, code, bubbles: true, ...mods });
  if (target) Object.defineProperty(e, "target", { value: target });
  return e;
};

describe("matchShortcut", () => {
  it("Ctrl+K recorta e Ctrl+Shift+Z refaz", () => {
    expect(matchShortcut(key("k", { ctrlKey: true }, "KeyK"))).toBe("tools.crop");
    expect(matchShortcut(key("Z", { ctrlKey: true, shiftKey: true }, "KeyZ"))).toBe("edit.redo");
    expect(matchShortcut(key("z", { ctrlKey: true }, "KeyZ"))).toBe("edit.undo");
  });

  it("não há dois comandos com o mesmo atalho (incluindo os alternativos)", () => {
    const all = [
      ...Object.entries(KEYMAP).map(([id, s]) => [id, s] as const),
      ...Object.entries(ALIASES).flatMap(([id, list]) => (list ?? []).map((s) => [id, s] as const)),
    ].filter(([, s]) => s);
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [id, s] of all) {
      const prev = seen.get(s);
      if (prev && prev !== id) dup.push(`${s}: ${prev} x ${id}`);
      seen.set(s, id);
    }
    expect(dup).toEqual([]);
  });

  it("ignora atalhos quando o foco está num input de texto", () => {
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    expect(matchShortcut(key("a", { ctrlKey: true }, "KeyA", input))).toBeNull();
    expect(matchShortcut(key("z", { ctrlKey: true }, "KeyZ", area))).toBeNull();
    expect(matchShortcut(key("ArrowRight", {}, "ArrowRight", input))).toBeNull();
    expect(matchShortcut(key("a", { ctrlKey: true }, "KeyA", document.body))).toBe("edit.selectAll");
  });

  it("atalhos migrados do visualizador (navegação, zoom, tela cheia)", () => {
    expect(matchShortcut(key("ArrowRight"))).toBe("go.next");
    expect(matchShortcut(key("PageDown"))).toBe("go.next");
    expect(matchShortcut(key("ArrowLeft"))).toBe("go.prev");
    expect(matchShortcut(key("PageUp"))).toBe("go.prev");
    expect(matchShortcut(key("Home"))).toBe("go.first");
    expect(matchShortcut(key("End"))).toBe("go.last");
    expect(matchShortcut(key("ArrowRight", { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key("0", { ctrlKey: true }, "Digit0"))).toBe("view.actualSize");
    expect(matchShortcut(key("9", { ctrlKey: true }, "Digit9"))).toBe("view.fit");
    expect(matchShortcut(key("=", { ctrlKey: true }, "Equal"))).toBe("view.zoomIn");
    expect(matchShortcut(key("+", { ctrlKey: true, shiftKey: true }, "Equal"))).toBe("view.zoomIn");
    expect(matchShortcut(key("+", { ctrlKey: true }, "NumpadAdd"))).toBe("view.zoomIn");
    expect(matchShortcut(key("-", { ctrlKey: true }, "Minus"))).toBe("view.zoomOut");
    expect(matchShortcut(key("*", { ctrlKey: true, shiftKey: true }, "Digit8"))).toBe("view.zoomToSelection");
    expect(matchShortcut(key("0", {}, "Digit0"))).toBeNull();
    expect(matchShortcut(key("F11", {}, "F11"))).toBe("view.fullscreen");
    expect(matchShortcut(key("f", { ctrlKey: true, metaKey: true }, "KeyF"))).toBe("view.fullscreen");
    expect(matchShortcut(key("F", { ctrlKey: true, shiftKey: true }, "KeyF"))).toBe("view.slideshow");
    expect(matchShortcut(key("Escape", {}, "Escape"))).toBe("edit.deselect");
    expect(matchShortcut(key("f", { ctrlKey: true }, "KeyF"))).toBeNull();
  });

  it("Ctrl+Alt+1/2/3 usa o código da tecla (layouts em que Alt muda o caractere)", () => {
    expect(matchShortcut(key("¹", { ctrlKey: true, altKey: true }, "Digit1"))).toBe("view.hideSidebar");
    expect(matchShortcut(key("2", { ctrlKey: true, altKey: true }, "Digit2"))).toBe("view.thumbnails");
    expect(matchShortcut(key("3", { ctrlKey: true, altKey: true }, "Digit3"))).toBe("view.contactSheet");
  });

  it("Ctrl+Shift+M é a barra de Marcação; Delete e Backspace apagam", () => {
    expect(matchShortcut(key("M", { ctrlKey: true, shiftKey: true }, "KeyM"))).toBe("view.markupBar");
    expect(matchShortcut(key("Delete", {}, "Delete"))).toBe("edit.delete");
    expect(matchShortcut(key("Backspace", {}, "Backspace"))).toBe("edit.delete");
  });

  it("tecla modificadora sozinha não é atalho", () => {
    expect(comboOf(key("Control", { ctrlKey: true }, "ControlLeft"))).toBeNull();
    expect(comboOf(key("Alt", { altKey: true }, "AltLeft"))).toBeNull();
  });
});

describe("formatShortcut", () => {
  it("mostra setas como símbolos e vazio como nada", () => {
    expect(formatShortcut("ArrowLeft")).toBe("←");
    expect(formatShortcut("Ctrl+Shift+Z")).toBe("Ctrl+Shift+Z");
    expect(formatShortcut("")).toBe("");
  });
});
