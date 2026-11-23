import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import i18n from "../i18n";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { AboutDialog } from "./AboutDialog";
import { enableNativeDecorations, resetForcedNative } from "../chrome/nativeDecorations";
import { addSignature, getSignatures, resetSignaturesForTests } from "../markup/signatures";
import { registerCommand, resetCommandsForTests } from "../shortcuts/commands";
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

describe("abas das Preferências", () => {
  const tab = (name: string) => screen.getByRole("tab", { name });
  const open = (name: string) => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    fireEvent.click(tab(name));
  };

  it("Geral, Imagens e Assinaturas, com setas e painel ligado à aba", () => {
    render(createElement(PreferencesDialog, { onClose: () => {} }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Geral", "Imagens", "Assinaturas"]);
    expect(tab("Geral").getAttribute("aria-selected")).toBe("true");
    tab("Geral").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Imagens"));
    expect(tab("Imagens").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tab("Imagens").id);
    expect(tab("Imagens").getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(tab("Assinaturas").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(tab("Geral").getAttribute("aria-selected")).toBe("true");
    expect([tab("Geral").tabIndex, tab("Imagens").tabIndex]).toEqual([0, -1]);
  });

  it("Imagens: 100% corresponde a, Texto ao Vivo e fundo da imagem", () => {
    open("Imagens");
    fireEvent.change(screen.getByLabelText("100% corresponde a"), { target: { value: "print" } });
    fireEvent.click(screen.getByLabelText("Texto ao Vivo"));
    fireEvent.click(screen.getByLabelText("Mostrar o fundo atrás da transparência"));
    expect(getPrefs()).toMatchObject({ actualSize: "print", liveText: false, showImageBackground: false });
  });

  it("Geral: abrir arquivos em, barra de abas e limite das versões", () => {
    open("Geral");
    fireEvent.change(screen.getByLabelText("Abrir arquivos"), { target: { value: "windows" } });
    fireEvent.click(screen.getByLabelText("Mostrar a barra de abas"));
    const mb = screen.getByLabelText("Espaço para versões anteriores (MB; 0 desliga)") as HTMLInputElement;
    fireEvent.change(mb, { target: { value: "" } });
    fireEvent.blur(mb);
    expect(mb.value).toBe("500");
    fireEvent.change(mb, { target: { value: "0" } });
    fireEvent.blur(mb);
    expect(getPrefs()).toMatchObject({ openFilesIn: "windows", tabBar: true, versionsMaxMb: 0 });
    fireEvent.change(mb, { target: { value: "999999999" } });
    fireEvent.keyDown(mb, { key: "Enter" });
    expect(getPrefs().versionsMaxMb).toBe(100_000);
  });

  it("valor digitado e não confirmado vale ao fechar com Esc", () => {
    const onClose = vi.fn();
    render(createElement(PreferencesDialog, { onClose }));
    const mb = screen.getByLabelText("Espaço para versões anteriores (MB; 0 desliga)");
    mb.focus();
    fireEvent.change(mb, { target: { value: "250" } });
    fireEvent.keyDown(mb, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(getPrefs().versionsMaxMb).toBe(250);
  });

  it("Assinaturas: lista e remove as salvas; sem nenhuma, avisa", async () => {
    resetSignaturesForTests();
    await addSignature("QUJD");
    await addSignature("REVG");
    open("Assinaturas");
    expect(await screen.findAllByRole("img", { name: /^Assinatura \d$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remover assinatura 1" }));
    await vi.waitFor(() => expect(getSignatures().map((s) => s.png)).toEqual(["QUJD"]));
    fireEvent.click(screen.getByRole("button", { name: "Remover assinatura 1" }));
    expect(await screen.findByText("Nenhuma assinatura salva.")).toBeTruthy();
    expect(document.activeElement).toBe(tab("Assinaturas"));
  });

  it("Criar Assinatura fecha as Preferências e abre o painel (só com imagem)", async () => {
    resetCommandsForTests();
    const run = vi.fn();
    const onClose = vi.fn();
    render(createElement(PreferencesDialog, { onClose }));
    fireEvent.click(tab("Assinaturas"));
    const create = screen.getByRole("button", { name: "Criar Assinatura…" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    act(() => void registerCommand("tools.annotate.signature", run));
    fireEvent.click(create);
    expect(onClose).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
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
