import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import i18n from "../i18n";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { AboutDialog } from "./AboutDialog";
import { PreferencesDialog } from "./PreferencesDialog";

beforeEach(async () => {
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  await vi.waitFor(() => expect(i18n.language).toBe("pt-BR"));
});
afterEach(cleanup);

describe("PreferencesDialog", () => {
  it("altera preferências e troca o idioma da interface", async () => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    expect(screen.getByRole("dialog", { name: "Preferências" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Idioma"), { target: { value: "en" } });
    expect(getPrefs().language).toBe("en");
    await vi.waitFor(() => expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy());
  });

  it("desliga a decoração nativa pela preferência", () => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    fireEvent.click(screen.getByLabelText("Usar a barra de título do sistema"));
    expect(getPrefs().nativeDecorations).toBe(true);
    fireEvent.click(screen.getByLabelText("Usar a barra de título do sistema"));
    expect(getPrefs().nativeDecorations).toBe(false);
  });
});

describe("AboutDialog", () => {
  it("mostra versão, licença e repositório", async () => {
    render(createElement(AboutDialog, { onClose: () => {} }));
    expect(await screen.findByText("Versão 1.2.3")).toBeTruthy();
    expect(screen.getByText("Licença MIT")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toContain("junior9283/gera-view-image");
  });
});
