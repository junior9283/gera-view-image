import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metadata = vi.fn();
const openUrl = vi.fn();
vi.mock("../ipc/commands", () => ({ metadata: (...a: unknown[]) => metadata(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }));

import type { DocInfo, Metadata } from "../ipc/types";
import { useDocs } from "../store/docs";
import { InspectorHost } from "./Inspector";
import { setAnnotationSource } from "./annotations";
import { getPendingKeywords, resetKeywordsForTests } from "./keywords";
import { toggleInspector } from "./toggle";

const info: DocInfo = {
  id: 7, path: "/x/a.jpg", name: "a.jpg", format: "jpeg", width: 32, height: 24, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
};

const meta: Metadata = {
  general: {
    width: 32, height: 24, dpi: [72, 72], colorModel: "RGB", profile: "sRGB IEC61966-2.1", depth: 8,
    hasAlpha: false, fileSize: 2048, created: null, modified: "2024-05-01T10:00:00Z",
  },
  exif: [["Make", "Gera"], ["Model", "TestCam"]],
  iptc: [["Title", "Praia"]],
  gps: { lat: 48.858333, lon: -122.419444, alt: 15.5 },
  keywords: ["mar"],
};

async function abrir() {
  render(createElement(InspectorHost));
  act(() => toggleInspector());
  await screen.findByRole("tab", { name: "Geral" });
}

beforeEach(() => {
  metadata.mockReset().mockResolvedValue(meta);
  openUrl.mockReset();
  resetKeywordsForTests();
  setAnnotationSource(null);
  useDocs.setState({ docs: [info], activeId: 7 });
});
afterEach(cleanup);

describe("Inspector", () => {
  it("fica oculto até toggleInspector() e alterna", async () => {
    render(createElement(InspectorHost));
    expect(screen.queryByRole("complementary")).toBeNull();
    act(() => toggleInspector());
    expect(await screen.findByRole("complementary", { name: "Informações" })).toBeTruthy();
    act(() => toggleInspector());
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("aba Geral mostra dimensões, perfil e tamanho", async () => {
    await abrir();
    expect(metadata).toHaveBeenCalledWith(7);
    await screen.findByText("sRGB IEC61966-2.1");
    expect(screen.getByText("32 × 24 px")).toBeTruthy();
    expect(screen.getByText("2,0 KB")).toBeTruthy();
  });

  it("aba EXIF lista os campos e IPTC os seus", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "EXIF" }));
    expect(await screen.findByText("TestCam")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "IPTC" }));
    expect(await screen.findByText("Praia")).toBeTruthy();
  });

  it("aba GPS mostra graus e minutos e abre o mapa", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "GPS" }));
    expect(await screen.findByText("48° 51.500′ N")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abrir no mapa" }));
    expect(openUrl).toHaveBeenCalledWith("https://www.openstreetmap.org/?mlat=48.858333&mlon=-122.419444");
  });

  it("GPS ausente mostra aviso, sem botão de mapa", async () => {
    metadata.mockResolvedValue({ ...meta, gps: null });
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "GPS" }));
    expect(await screen.findByText("Sem dados de localização.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abrir no mapa" })).toBeNull();
  });

  it("palavras-chave: adiciona e remove, expondo a pendência para a Task 11", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Palavras-chave" }));
    await screen.findByText("mar");
    expect(getPendingKeywords(7)).toBeNull();
    fireEvent.change(screen.getByLabelText("Nova palavra-chave"), { target: { value: "sol" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    expect(screen.getByText("sol")).toBeTruthy();
    expect(getPendingKeywords(7)).toEqual(["mar", "sol"]);
    fireEvent.click(screen.getByRole("button", { name: "Remover mar" }));
    expect(getPendingKeywords(7)).toEqual(["sol"]);
  });

  it("anotações: lista vazia sem fonte; com fonte, clicar seleciona", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Anotações" }));
    expect(await screen.findByText("Nenhuma anotação.")).toBeTruthy();
    const select = vi.fn();
    act(() =>
      setAnnotationSource({
        list: () => [{ id: "a1", kind: "text", label: "Olá" }],
        subscribe: () => () => {},
        select,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Olá/ }));
    expect(select).toHaveBeenCalledWith(7, "a1");
  });

  it("erro ao ler os metadados aparece na aba", async () => {
    metadata.mockRejectedValue({ code: "io", message: "x" });
    await abrir();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });
});
