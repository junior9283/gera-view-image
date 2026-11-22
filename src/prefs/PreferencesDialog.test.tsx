import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import i18n from "../i18n";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { AboutDialog } from "./AboutDialog";
import { enableNativeDecorations, resetForcedNative } from "../chrome/nativeDecorations";
import { PreferencesDialog } from "./PreferencesDialog";

beforeEach(async () => {
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  await vi.waitFor(() => expect(i18n.language).toBe("pt-BR"));
});
afterEach(() => {
  cleanup();
  resetForcedNative();
});

describe("PreferencesDialog", () => {
  it("altera preferências e troca o idioma da interface", async () => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    expect(screen.getByRole("dialog", { name: "Preferências" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Idioma"), { target: { value: "en" } });
    expect(getPrefs().language).toBe("en");
    await vi.waitFor(() => expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy());
  });

  it("arrastar a imagem: seleciona por padrão e a preferência passa a movê-la", () => {
    expect(getPrefs().dragPans).toBe(false);
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    fireEvent.click(screen.getByLabelText("Arrastar move a imagem (em vez de selecionar)"));
    expect(getPrefs().dragPans).toBe(true);
  });

  it("desliga a decoração nativa pela preferência", () => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    fireEvent.click(screen.getByLabelText("Usar a barra de título do sistema"));
    expect(getPrefs().nativeDecorations).toBe(true);
    fireEvent.click(screen.getByLabelText("Usar a barra de título do sistema"));
    expect(getPrefs().nativeDecorations).toBe(false);
  });
});

describe("PreferencesDialog: casos extras", () => {
  it("segundos da apresentação: edita livremente e aplica round + clamp ao perder o foco", () => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    const input = screen.getByLabelText("Segundos por imagem na apresentação") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "99.4" } });
    expect(getPrefs().slideshowSeconds).toBe(3);
    fireEvent.blur(input);
    expect(getPrefs().slideshowSeconds).toBe(60);
    expect(input.value).toBe("60");
  });

  it("sem compositor o checkbox aparece marcado e desabilitado, com dica", () => {
    enableNativeDecorations();
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    const box = screen.getByLabelText("Usar a barra de título do sistema") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.title).toContain("Indisponível");
    expect(getPrefs().nativeDecorations).toBe(false);
  });
});

describe("AboutDialog", () => {
  it("mostra versão, licença e repositório", async () => {
    render(createElement(AboutDialog, { onClose: () => {} }));
    expect(await screen.findByText("Versão 1.2.3")).toBeTruthy();
    expect(screen.getByText("Licença MIT")).toBeTruthy();
    const [repo, licenses] = screen.getAllByRole("link");
    expect(repo.getAttribute("href")).toContain("junior9283/gera-view-image");
    expect(licenses.getAttribute("href")).toMatch(/gera-view-image\/blob\/v1\.2\.3\/THIRD_PARTY_LICENSES$/);
  });
});
