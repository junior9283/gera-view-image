import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, TextLine } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests } from "../store/ui";
import { useMarkup } from "../markup/store";
import { LiveTextLayer } from "./LiveTextLayer";
import { LiveTextHost } from "./LiveTextHost";
import { buildModel } from "./text";
import { openFind, resetLiveTextForTests, sync, useLiveText } from "./store";

const line = (y: number, ...words: string[]): TextLine => {
  let x = 0;
  const ws = words.map((text) => {
    const w = { text, bbox: { x, y, w: text.length * 10, h: 20 } };
    x += text.length * 10 + 10;
    return w;
  });
  return { text: words.join(" "), bbox: { x: 0, y, w: x - 10, h: 20 }, words: ws };
};
const LINES = [line(0, "Ação", "e", "coração"), line(40, "Visite", "https://gera.dev")];

const doc = (id: number, rev = 0) =>
  ({ id, rev, path: `/a/${id}.png`, name: `${id}.png`, width: 400, height: 100, frames: 1, error: null }) as unknown as DocInfo;

const props = { scale: 1, panX: 0, panY: 0, imageW: 400, imageH: 100 };
const ready = () => useLiveText.setState({ status: "ready", key: "1:0:0", model: buildModel(LINES) });
const word = (i: number) => document.querySelector(`[data-word="${i}"]`)!;
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
  invoke.mockReset();
  resetLiveTextForTests();
  resetPrefsForTests();
  resetUiForTests();
  useSelection.setState({ selection: null, selectionTool: null });
  useMarkup.setState({ visible: false });
  useDocs.setState({ docs: [], activeId: null });
});
afterEach(() => cleanup());

describe("camada do Texto ao Vivo", () => {
  it("arrastar sobre as palavras seleciona e Ctrl+C copia o texto", async () => {
    ready();
    render(<LiveTextLayer {...props} />);
    fireEvent.pointerDown(word(1), { button: 0, clientX: 55, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 15, clientY: 50 });
    fireEvent.pointerUp(window);
    expect(useLiveText.getState().sel).toEqual({ a: 1, b: 3 });
    expect(screen.getAllByTestId("livetext-sel")).toHaveLength(2);
    invoke.mockResolvedValue(undefined);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    await act(async () => {});
    expect(calls("copy_text")).toEqual([["copy_text", { text: "e coração\nVisite" }]]);
  });

  it("o pointerdown na palavra não chega à Viewport (sem pan)", () => {
    ready();
    const outer = vi.fn();
    const { container } = render(<LiveTextLayer {...props} />);
    container.addEventListener("pointerdown", outer);
    fireEvent.pointerDown(word(0), { button: 0 });
    expect(outer).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId("livetext-layer"), { button: 0 });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("clique simples não seleciona; duplo seleciona a palavra; clicar fora desmarca", () => {
    ready();
    render(<LiveTextLayer {...props} />);
    fireEvent.pointerDown(word(2), { button: 0 });
    fireEvent.pointerUp(window);
    expect(useLiveText.getState().sel).toBeNull();
    fireEvent.pointerDown(word(2), { button: 0 });
    fireEvent.mouseDown(word(2), { detail: 2 });
    fireEvent.pointerUp(window);
    expect(useLiveText.getState().sel).toEqual({ a: 2, b: 2 });
    fireEvent.pointerDown(document.body);
    expect(useLiveText.getState().sel).toBeNull();
  });

  it("com a Marcação ou uma ferramenta de seleção, as palavras não capturam o ponteiro", () => {
    ready();
    useMarkup.setState({ visible: true });
    render(<LiveTextLayer {...props} />);
    expect(document.querySelector("[data-word]")).toBeNull();
  });

  it("botão do canto liga o destaque, com links clicáveis", async () => {
    ready();
    useLiveText.setState({ data: [{ kind: "link", text: "https://gera.dev", href: "https://gera.dev", start: 0, end: 0, words: [4] }] });
    render(<LiveTextLayer {...props} />);
    expect(screen.queryByTestId("livetext-data")).toBeNull();
    fireEvent.click(screen.getByTestId("livetext-button"));
    expect(useLiveText.getState().highlight).toBe(true);
    invoke.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("livetext-data"));
    await act(async () => {});
    expect(calls("open_web")).toEqual([["open_web", { kind: "link", text: "https://gera.dev", lang: "" }]]);
  });

  it("sem modelos, o download só começa depois de confirmar", async () => {
    useLiveText.setState({ status: "needsModels", key: "1:0:0" });
    invoke.mockResolvedValue(undefined);
    render(<LiveTextLayer {...props} />);
    fireEvent.click(screen.getByTestId("livetext-download"));
    expect(calls("download_ocr_models")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("livetext-download-confirm"));
    await act(async () => {});
    expect(calls("download_ocr_models")).toHaveLength(1);
  });
});

describe("Localizar", () => {
  it("Ctrl+F abre a barra, destaca as ocorrências sem acento e Enter avança", () => {
    ready();
    render(
      <>
        <LiveTextLayer {...props} />
        <LiveTextHost />
      </>,
    );
    act(() => openFind());
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "acao" } });
    expect(screen.getAllByTestId("livetext-find")).toHaveLength(2);
    expect(screen.getByRole("search").textContent).toMatch(/1 (de|of) 2/);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useLiveText.getState().find.index).toBe(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("livetext-find-bar")).toBeNull();
  });
});

describe("controlador", () => {
  const route = (models: boolean, lines: TextLine[] = LINES) =>
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ocr_models") return { installed: models, downloadBytes: models ? 0 : 100 };
      if (cmd === "recognize_text") return lines;
      if (cmd === "detect_codes") return [];
    });

  it("sem modelos não reconhece nem baixa nada", async () => {
    route(false);
    useDocs.setState({ docs: [doc(1)], activeId: 1 });
    await sync();
    expect(useLiveText.getState().status).toBe("needsModels");
    expect(calls("recognize_text")).toHaveLength(0);
    expect(calls("download_ocr_models")).toHaveLength(0);
  });

  it("reconhece o documento ativo e usa o quadro da barra lateral", async () => {
    route(true);
    useDocs.setState({ docs: [doc(1)], activeId: 1 });
    await sync();
    expect(calls("recognize_text")).toEqual([["recognize_text", { id: 1, frame: 0 }]]);
    expect(useLiveText.getState().status).toBe("ready");
    expect(useLiveText.getState().data.map((d) => d.kind)).toEqual(["link"]);
    await sync();
    expect(calls("recognize_text")).toHaveLength(1);
  });

  it("resultado de uma imagem que deixou de ser a ativa é descartado", async () => {
    const pending: ((l: TextLine[]) => void)[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ocr_models") return { installed: true, downloadBytes: 0 };
      if (cmd === "recognize_text") return new Promise((r) => pending.push(r));
      return [];
    });
    useDocs.setState({ docs: [doc(1), doc(2)], activeId: 1 });
    const first = sync();
    await act(async () => {});
    useDocs.setState({ activeId: 2 });
    const second = sync();
    await act(async () => {});
    pending[0](LINES);
    await first;
    expect(useLiveText.getState().key).toBe("2:0:0");
    expect(useLiveText.getState().model).toBeNull();
    pending[1]([]);
    await second;
    expect(useLiveText.getState().status).toBe("ready");
  });

  it("desligar o Texto ao Vivo cancela e limpa", async () => {
    route(true);
    useDocs.setState({ docs: [doc(1)], activeId: 1 });
    await sync();
    useLiveText.setState({ status: "running" });
    setPrefs({ liveText: false });
    await sync();
    expect(calls("cancel_text_recognition")).toHaveLength(1);
    expect(useLiveText.getState()).toMatchObject({ status: "off", model: null });
  });
});
