// Texto alternativo da imagem exibida: num TIFF, a descrição da página mostrada.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metadata = vi.fn();
vi.mock("../ipc/commands", () => ({ metadata: (...a: unknown[]) => metadata(...a) }));

import type { DocInfo } from "../ipc/types";
import { resetTextEditsForTests, setText } from "../inspector/textEdits";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import { useImageAlt } from "./imageAlt";

const tiff = {
  id: 9, path: "/x/páginas.tiff", name: "páginas.tiff", format: "tiff", width: 10, height: 10, frames: 2,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
} as DocInfo;
const descriptions = ["Praia de Copacabana", "Serra da Mantiqueira"];

beforeEach(() => {
  vi.useFakeTimers();
  resetTextEditsForTests();
  useDocs.setState({ docs: [tiff], activeId: 9 });
  useUi.setState({ page: 1 });
  metadata.mockReset().mockImplementation(async (_id: number, page = 0) => ({
    texts: { title: null, description: descriptions[page], author: null, altText: null },
  }));
});
afterEach(() => {
  vi.useRealTimers();
  useUi.setState({ page: null });
});

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(700)));

describe("useImageAlt", () => {
  it("usa a descrição da página exibida, e a edição vale em todas", async () => {
    const { result } = renderHook(() => useImageAlt(tiff));
    await settle();
    expect(metadata).toHaveBeenCalledWith(9, 1);
    expect(result.current).toBe("páginas.tiff: Serra da Mantiqueira");
    act(() => useUi.getState().setPage(0));
    await settle();
    expect(result.current).toBe("páginas.tiff: Praia de Copacabana");
    act(() => setText(9, "description", "Céu de junho", 0));
    act(() => useUi.getState().setPage(1));
    expect(result.current).toBe("páginas.tiff: Céu de junho");
  });
});
