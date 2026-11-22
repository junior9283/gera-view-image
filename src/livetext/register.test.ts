import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (cmd: string) => (cmd === "ocr_models" ? { installed: false, downloadBytes: 1 } : undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { isEnabled } from "../shortcuts/commands";
import { openFind, resetLiveTextForTests, setFindQuery, useLiveText } from "./store";
import { buildModel } from "./text";
import "./register";

const model = buildModel([
  {
    text: "Olá mundo",
    bbox: { x: 0, y: 0, w: 90, h: 20 },
    words: [
      { text: "Olá", bbox: { x: 0, y: 0, w: 30, h: 20 } },
      { text: "mundo", bbox: { x: 40, y: 0, w: 50, h: 20 } },
    ],
  },
]);

describe("registro do Lote 3", () => {
  beforeEach(() => resetLiveTextForTests());

  it("comandos de texto ficam desabilitados sem texto reconhecido", () => {
    for (const id of ["edit.find", "edit.startSpeaking", "tools.copyAllText", "tools.translateText", "tools.searchText"] as const) {
      expect(isEnabled(id)).toBe(false);
    }
    useLiveText.setState({ status: "ready", model });
    expect(isEnabled("edit.find")).toBe(true);
    expect(isEnabled("tools.copyAllText")).toBe(true);
    expect(isEnabled("edit.findNext")).toBe(false);
    openFind();
    setFindQuery("mun");
    expect(isEnabled("edit.findNext")).toBe(true);
    expect(isEnabled("edit.stopSpeaking")).toBe(false);
    expect(isEnabled("tools.liveText")).toBe(true);
  });

  it("Pesquisar Imagem na Web exige uma imagem aberta", () => {
    expect(isEnabled("tools.searchImageWeb")).toBe(false);
  });
});
