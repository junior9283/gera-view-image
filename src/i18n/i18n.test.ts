import { describe, expect, it } from "vitest";
import en from "./en.json";
import ptBR from "./pt-BR.json";
import i18n, { errorMessage, resolveLanguage } from "./index";

function keys(o: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("i18n", () => {
  it("pt-BR e en têm exatamente as mesmas chaves", () => {
    expect(keys(en).sort()).toEqual(keys(ptBR).sort());
  });

  it("resolve o idioma pelo sistema, com override da preferência", () => {
    expect(resolveLanguage("system", "pt-PT")).toBe("pt-BR");
    expect(resolveLanguage("system", "pt-BR")).toBe("pt-BR");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "fr-FR")).toBe("en");
    expect(resolveLanguage("en", "pt-BR")).toBe("en");
    expect(resolveLanguage("pt-BR", "en-US")).toBe("pt-BR");
  });

  it("traduz e troca de idioma", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("window.close")).toBe("Close");
    await i18n.changeLanguage("pt-BR");
    expect(i18n.t("window.close")).toBe("Fechar");
  });

  it("traduz códigos de erro do núcleo, com mensagem própria para HEIC sem libde265", async () => {
    await i18n.changeLanguage("pt-BR");
    expect(errorMessage("heic_decoder_missing")).toBe("Para abrir HEIC, instale a libde265 (no Fedora: RPM Fusion)");
    expect(errorMessage("corrupt")).not.toBe("errors.corrupt");
    await i18n.changeLanguage("en");
    expect(errorMessage("heic_decoder_missing")).toBe("To open HEIC, install libde265 (on Fedora: RPM Fusion)");
    for (const code of ["not_found", "unsupported", "corrupt", "io", "permission", "changed_on_disk", "empty_selection"] as const) {
      expect(errorMessage(code)).not.toBe(`errors.${code}`);
    }
    await i18n.changeLanguage("pt-BR");
  });
});

// Lint simples: texto JSX literal com letras precisa passar por t().
const EXCECOES = new Set<string>(["Gera View Image"]);

const fontes = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function literais(src: string): string[] {
  const limpo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const achados: string[] = [];
  // Texto entre tags: >texto<
  for (const m of limpo.matchAll(/(?<![=-])>([^<>{}=;()]*\p{L}[^<>{}=;()]*)</gu)) achados.push(m[1].trim());
  // Atributos visíveis com literal
  for (const m of limpo.matchAll(/\b(?:aria-label|title|alt|placeholder|label)="([^"]*\p{L}[^"]*)"/gu)) achados.push(m[1]);
  return achados.filter((s) => s && !EXCECOES.has(s));
}

describe("strings visíveis", () => {
  it("nenhuma string visível hardcoded nos .tsx", () => {
    expect(Object.keys(fontes).length).toBeGreaterThan(0);
    const ruins = Object.entries(fontes).flatMap(([f, src]) => literais(src).map((s) => `${f}: ${s}`));
    expect(ruins).toEqual([]);
  });

  it("o detector pega texto literal", () => {
    expect(literais("<b>Olá</b>")).toEqual(["Olá"]);
    expect(literais('<img alt="Logo" />')).toEqual(["Logo"]);
    expect(literais("<b>{t('x')}</b>")).toEqual([]);
  });
});
