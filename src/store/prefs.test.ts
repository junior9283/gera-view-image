import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, unknown>();
let failLoad = false;
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    if (failLoad) throw new Error("sem store");
    return {
      get: async (k: string) => disk.get(k),
      set: async (k: string, v: unknown) => void disk.set(k, v),
      save: async () => {},
      delete: async (k: string) => disk.delete(k),
    };
  }),
}));

import { DEFAULT_PREFS, getPrefs, loadPrefs, resetPrefsForTests, setPrefs } from "./prefs";

beforeEach(() => {
  disk.clear();
  failLoad = false;
  localStorage.clear();
  resetPrefsForTests();
});

describe("prefs", () => {
  it("carrega padrões quando arquivo ausente", async () => {
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("carrega padrões quando o store falha", async () => {
    failLoad = true;
    expect(await loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("ignora chave inválida mantendo padrão e chaves desconhecidas", async () => {
    disk.set("background", "roxo");
    disk.set("slideshowSeconds", "abc");
    disk.set("language", "en");
    disk.set("chaveNova", 42);
    const p = await loadPrefs();
    expect(p.background).toBe(DEFAULT_PREFS.background);
    expect(p.slideshowSeconds).toBe(DEFAULT_PREFS.slideshowSeconds);
    expect(p.language).toBe("en");
    expect(p).not.toHaveProperty("chaveNova");
  });

  it("Abrir Recente saiu: a lista antiga do prefs.json é descartada sem erro e apagada do disco", async () => {
    disk.set("recent", ["/fotos/Férias/Praia.jpg"]);
    disk.set("language", "en");
    const p = await loadPrefs();
    expect(p).not.toHaveProperty("recent");
    expect(p.language).toBe("en");
    await vi.waitFor(() => expect(disk.has("recent")).toBe(false));
  });

  it("persiste alterações no store", async () => {
    await loadPrefs();
    setPrefs({ browseFolder: false });
    await vi.waitFor(() => expect(disk.get("browseFolder")).toBe(false));
  });

  it("migra valores do localStorage uma vez e os remove", async () => {
    localStorage.setItem("update.auto", "false");
    localStorage.setItem("update.lastCheck", "2026-01-01T00:00:00.000Z");
    localStorage.setItem("update.skipped", "0.3.0");
    localStorage.setItem("gvi.nativeDecorations", "1");
    const p = await loadPrefs();
    expect(p.autoUpdate).toBe(false);
    expect(p.lastUpdateCheck).toBe("2026-01-01T00:00:00.000Z");
    expect(p.skippedVersion).toBe("0.3.0");
    expect(p.nativeDecorations).toBe(false);
    expect(disk.get("skippedVersion")).toBe("0.3.0");
    expect(localStorage.getItem("update.skipped")).toBeNull();
    expect(localStorage.getItem("gvi.nativeDecorations")).toBeNull();
  });

  it("setPrefs antes do carregamento terminar não se perde e é gravado", async () => {
    disk.set("browseFolder", true);
    disk.set("openBehavior", "actual");
    const loading = loadPrefs();
    setPrefs({ browseFolder: false });
    const p = await loading;
    expect(p.browseFolder).toBe(false);
    expect(p.openBehavior).toBe("actual");
    await vi.waitFor(() => expect(disk.get("browseFolder")).toBe(false));
  });

  it("o store tem precedência sobre o localStorage", async () => {
    disk.set("skippedVersion", "0.4.0");
    localStorage.setItem("update.skipped", "0.3.0");
    expect((await loadPrefs()).skippedVersion).toBe("0.4.0");
  });
});
