import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { checkForUpdate, isSkipped, shouldCheck, skipVersion } from "./updater";

const now = new Date("2026-11-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

describe("shouldCheck", () => {
  it("verifica quando nunca verificou", () => expect(shouldCheck(null, now, true)).toBe(true));
  it("não verifica antes de 24 h", () => expect(shouldCheck(hoursAgo(23), now, true)).toBe(false));
  it("verifica após 24 h", () => expect(shouldCheck(hoursAgo(25), now, true)).toBe(true));
  it("não verifica com automático desligado", () => expect(shouldCheck(null, now, false)).toBe(false));
});

describe("isSkipped", () => {
  it("igual à versão pulada", () => expect(isSkipped("0.2.0", "0.2.0")).toBe(true));
  it("diferente ou nada pulado", () => {
    expect(isSkipped("0.2.1", "0.2.0")).toBe(false);
    expect(isSkipped("0.2.0", null)).toBe(false);
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    localStorage.clear();
    check.mockReset();
  });
  const upd = { version: "0.2.0", body: "notas", date: "2026-11-19" };

  it("manual ignora intervalo e versão pulada e devolve UpdateInfo", async () => {
    skipVersion("0.2.0");
    localStorage.setItem("update.lastCheck", new Date().toISOString());
    check.mockResolvedValue(upd);
    expect(await checkForUpdate({ manual: true })).toEqual({ version: "0.2.0", notes: "notas", date: "2026-11-19" });
  });

  it("automático respeita o intervalo", async () => {
    localStorage.setItem("update.lastCheck", new Date().toISOString());
    expect(await checkForUpdate({ manual: false })).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("automático não oferece versão pulada", async () => {
    skipVersion("0.2.0");
    check.mockResolvedValue(upd);
    expect(await checkForUpdate({ manual: false })).toBeNull();
  });

  it("sem atualização devolve null", async () => {
    check.mockResolvedValue(null);
    expect(await checkForUpdate({ manual: true })).toBeNull();
  });
});
