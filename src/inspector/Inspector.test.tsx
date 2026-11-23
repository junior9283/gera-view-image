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
import { getPendingTextEdits, resetTextEditsForTests } from "./textEdits";
import { openInspectorTab, toggleInspector } from "./toggle";
import { useSelection } from "../store/selection";

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
  sections: [],
  maker: null,
  lens: [],
  texts: { title: null, description: null, author: null, altText: null },
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
  resetTextEditsForTests();
  useSelection.setState({ selection: null });
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
    expect(metadata).toHaveBeenCalledWith(7, 0);
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

  it("abas do formato, do fabricante e da lente só aparecem quando o arquivo as tem", async () => {
    metadata.mockResolvedValue({
      ...meta,
      sections: [{ id: "jfif", rows: [["JFIF Version", "1.02"]] }, { id: "tiff", rows: [["Software", "<b>x</b>"]] }],
      maker: { name: "Canon", rows: [["Lens Model", "EF50mm"]] },
      lens: [["Lens Model", "EF50mm"]],
    });
    await abrir();
    expect(await screen.findByRole("tab", { name: "JFIF" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "PNG" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "JFIF" }));
    expect(await screen.findByText("1.02")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "TIFF" }));
    // Texto vindo do arquivo nunca vira HTML.
    expect(await screen.findByText("<b>x</b>")).toBeTruthy();
    expect(document.querySelector(".inspector-body b")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Canon" }));
    expect((await screen.findAllByText("EF50mm")).length).toBe(1);
    fireEvent.click(screen.getByRole("tab", { name: "Lente" }));
    expect(await screen.findByText("EF50mm")).toBeTruthy();
  });

  it("aba Descrição edita título, descrição, autor e texto alternativo e deixa pendente", async () => {
    metadata.mockResolvedValue({ ...meta, texts: { ...meta.texts, title: "Praia" } });
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Descrição" }));
    const title = (await screen.findByLabelText("Título")) as HTMLInputElement;
    expect(title.value).toBe("Praia");
    expect(getPendingTextEdits(7)).toBeNull();
    fireEvent.change(title, { target: { value: "Mar" } });
    fireEvent.change(screen.getByLabelText("Autor"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Descrição da Imagem (texto alternativo)"), { target: { value: "Um gato" } });
    expect(getPendingTextEdits(7)).toEqual({ title: "Mar", author: "Ana", altText: "Um gato" });
  });

  it("openInspectorTab abre o Inspetor direto na aba pedida", async () => {
    render(createElement(InspectorHost));
    act(() => openInspectorTab("description"));
    expect(await screen.findByLabelText("Título")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Descrição", selected: true })).toBeTruthy();
  });

  it("aba Recorte: sem seleção avisa; com retângulo mostra e edita posição e tamanho", async () => {
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Recorte" }));
    expect(await screen.findByText(/Sem seleção/)).toBeTruthy();
    act(() => useSelection.setState({ selection: { type: "rect", data: { x: 4, y: 6, w: 10, h: 8 } } }));
    const w = (await screen.findByLabelText("Largura")) as HTMLInputElement;
    expect(w.value).toBe("10");
    expect((screen.getByLabelText("Posição X") as HTMLInputElement).value).toBe("4");
    fireEvent.change(w, { target: { value: "99" } });
    fireEvent.blur(w);
    // limitada à imagem (32 de largura, a partir de x=4)
    expect(useSelection.getState().selection).toEqual({ type: "rect", data: { x: 4, y: 6, w: 28, h: 8 } });
    // unidade: 1 pol = 72 px com 72 ppp
    fireEvent.change(screen.getByLabelText("Unidade"), { target: { value: "in" } });
    expect((screen.getByLabelText("Posição X") as HTMLInputElement).value).toBe("0.06");
  });

  it("aba Recorte: sair do campo sem mudar o texto não regrava a seleção", async () => {
    const original = { type: "rect", data: { x: 4.4, y: 6, w: 10, h: 8 } } as const;
    useSelection.setState({ selection: original });
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Recorte" }));
    const x = (await screen.findByLabelText("Posição X")) as HTMLInputElement;
    expect(x.value).toBe("4"); // mostra arredondado; o valor real é 4,4
    fireEvent.blur(x);
    expect(useSelection.getState().selection).toBe(original);
    fireEvent.change(x, { target: { value: "5" } });
    fireEvent.blur(x);
    expect(useSelection.getState().selection).toEqual({ type: "rect", data: { x: 5, y: 6, w: 10, h: 8 } });
  });

  it("aba Recorte: seleção livre mostra a caixa, só para leitura", async () => {
    useSelection.setState({ selection: { type: "polygon", data: [[2, 3], [12, 3], [7, 13]] } });
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Recorte" }));
    const h = (await screen.findByLabelText("Altura")) as HTMLInputElement;
    expect(h.value).toBe("10");
    expect(h.disabled).toBe(true);
  });

  it("rótulos e valores comuns em português; texto do arquivo como está", async () => {
    metadata.mockResolvedValue({ ...meta, exif: [["Make", "Yes"], ["MeteringMode", "pattern"], ["Tag X", "v"]] });
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "EXIF" }));
    const row = (dt: string) => screen.getByText(dt).nextElementSibling?.textContent;
    await screen.findByText("Fabricante");
    expect([row("Fabricante"), row("Modo de Medição"), row("Tag X")]).toEqual(["Yes", "Matricial", "v"]);
  });

  it("Anotações mostram o tipo em português, sem repetir o nome", async () => {
    setAnnotationSource({
      list: () => [
        { id: "a", kind: "text", label: "Olá, açaí" },
        { id: "b", kind: "roundRect", label: "Retângulo arredondado" },
        { id: "c", kind: "novo.tipo", label: "x" },
      ],
      subscribe: () => () => {},
      select: () => {},
    });
    await abrir();
    fireEvent.click(screen.getByRole("tab", { name: "Anotações" }));
    const texts = (await screen.findAllByRole("listitem")).map((li) => li.textContent?.trim());
    expect(texts).toEqual(["Texto Olá, açaí", "Retângulo arredondado", "novo.tipo x"]);
  });
});
