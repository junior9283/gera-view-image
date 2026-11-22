// L8: os diálogos seguem o tema (variáveis --chrome-*) e as cores passam no WCAG AA nos dois temas.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, readableOn } from "./contrast";

// Pelo disco: o Vitest troca o conteúdo dos .css importados por vazio.
const sheets = Object.fromEntries(
  readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(`src/${f}`, "utf8")]),
);
const sheet = (name: string) => sheets[`${name}.css`];
const themeCss = sheet("chrome/theme");

/** Variáveis de um bloco `seletor { --x: y; }` (o primeiro que casar). */
function vars(selector: string): Record<string, string> {
  const at = themeCss.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = themeCss.slice(at, themeCss.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = vars(":root");
const themes = { claro: light, escuro: { ...light, ...vars(':root[data-theme="dark"]') } };
const SURFACES = ["chrome-bg", "chrome-panel", "chrome-field", "chrome-button"] as const;

describe.each(Object.entries(themes))("contraste no tema %s", (_name, t) => {
  it("as variáveis são cores opacas", () => {
    for (const k of [...SURFACES, "chrome-fg", "chrome-muted", "chrome-danger", "chrome-link", "chrome-focus", "chrome-field-border"]) {
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("texto, texto secundário, erro e link: AA (4,5:1) em todas as superfícies", () => {
    for (const bg of SURFACES) {
      for (const fg of ["chrome-fg", "chrome-muted", "chrome-danger", "chrome-link"]) {
        expect(contrast(t[fg], t[bg]), `${fg} sobre ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("borda dos campos e anel de foco: 3:1", () => {
    for (const bg of SURFACES) {
      expect(contrast(t["chrome-focus"], t[bg]), `foco sobre ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t["chrome-field-border"], t[bg]), `borda sobre ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("tema nos diálogos", () => {
  it("color-scheme acompanha o tema", () => {
    expect(themeCss).toMatch(/:root \{[^}]*color-scheme: light;/);
    expect(themeCss).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/);
  });

  it("nenhuma folha fixa as cores escuras dos diálogos", () => {
    const fixed =
      /background:\s*(?:#2b2b2b|rgb\(43 43 43)|[^-]color:\s*#(?:eee|aaa|ff8a80|8ab4f8|ff3b30)\b|rgba?\(255,? 255,? 255,? ?\/? ?0\.(?:06|1|14|15|16|25)\)/;
    const names = [
      "file/file", "prefs/prefs", "adjust/adjust", "finder/finder", "updater/update", "inspector/inspector",
      "markup/markup", "print/print", "color/color", "subject/subject", "chrome/chrome", "livetext/livetext",
    ];
    for (const name of names) {
      // Sobre a imagem (não sobre a interface): o editor de texto da Marcação e o Texto ao Vivo.
      const css = sheet(name).replace(/\.(?:markup-text-editor|livetext-line|livetext-button|eyedropper-swatch span) \{[^}]*\}/g, "");
      expect(fixed.exec(css)?.[0], name).toBeUndefined();
    }
  });

  it("os painéis usam as superfícies do tema", () => {
    const panels: [string, string][] = [
      ["file/file", ".file-dialog"], ["prefs/prefs", ".prefs-dialog"], ["adjust/adjust", ".adjust-dialog"],
      ["finder/finder", ".finder-popover"], ["updater/update", ".update-dialog"], ["inspector/inspector", ".inspector"],
      ["livetext/livetext", ".livetext-offer"], ["livetext/livetext", ".livetext-menu"],
    ];
    for (const [name, sel] of panels) {
      const rule = new RegExp(`\\${sel}(?:,[^{]*)? \\{([^}]*)\\}`).exec(sheet(name))?.[1] ?? "";
      expect(rule, sel).toContain("background: var(--chrome-panel)");
      expect(rule, sel).toContain("color: var(--chrome-fg)");
    }
  });

  it("quem tira o contorno do foco mostra o foco de outro jeito", () => {
    for (const [file, css] of Object.entries(sheets)) {
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*outline:\s*(?:none|0)\b[^{}]*)\}/g)) {
        const container = /\.menu-item|\.shortcuts-dialog|\.tabs-veil|\[role="dialog"\]/.test(m[1]);
        expect(container || /background|border/.test(m[2]), `${file}: ${m[1].trim()}`).toBe(true);
      }
    }
  });

  it("respeita menos movimento e mais contraste", () => {
    const motion = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(themeCss)?.[1] ?? "";
    expect(motion).toMatch(/animation-duration: 0\.01ms !important/);
    expect(motion).toMatch(/animation-iteration-count: 1 !important/);
    expect(motion).toMatch(/transition-duration: 0\.01ms !important/);
    expect(themeCss).toMatch(/@media \(prefers-contrast: more\)/);
  });
});

describe("texto sobre a cor de destaque do sistema", () => {
  it.each(["#3daee9", "#0a84ff", "#e93d58", "#000000", "#ffffff", "#7f7f7f", "#f6d32d", "#9141ac"])("%s passa no AA", (accent) => {
    expect(contrast(readableOn(accent), accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("cor que não dá para ler fica com preto", () => {
    expect(readableOn("accentcolor")).toBe("#000000");
  });

  it("o contraste segue a fórmula do WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
