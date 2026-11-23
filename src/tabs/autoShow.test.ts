// Várias imagens no modo "abas": a barra de abas aparece sozinha, salvo se o usuário a ocultou.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import { runCommand } from "../shortcuts/commands";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { autoShowMany } from "./autoShow";
import "./register";

beforeEach(() => {
  resetPrefsForTests();
  resetUiForTests();
});

describe("barra de abas automática", () => {
  it("modo abas: aparece na primeira vez", () => {
    setPrefs({ openFilesIn: "tabs" });
    autoShowMany();
    expect(getPrefs().tabBar).toBe(true);
  });

  it("quem ocultou a barra (Visualizar › Ocultar Barra de Abas) não a vê voltar sozinha", () => {
    setPrefs({ openFilesIn: "tabs" });
    runCommand("view.tabBar");
    runCommand("view.tabBar");
    expect(getPrefs()).toMatchObject({ tabBar: false, tabBarHidden: true });
    autoShowMany();
    expect(getPrefs().tabBar).toBe(false);
    runCommand("view.tabBar");
    expect(getPrefs()).toMatchObject({ tabBar: true, tabBarHidden: false });
  });

  it("na mesma janela, a barra lateral continua aparecendo", () => {
    setPrefs({ tabBarHidden: true });
    autoShowMany();
    expect(useUi.getState().sidebar).toBe("thumbs");
  });
});
