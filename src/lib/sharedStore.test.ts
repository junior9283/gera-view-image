import { describe, expect, it, vi } from "vitest";
import type { Store } from "@tauri-apps/plugin-store";
import { shareStore } from "./sharedStore";

type Cb = (key: string, value: unknown) => void;

/** O plugin avisa todas as janelas, inclusive a que gravou. */
function plugin() {
  const cbs: Cb[] = [];
  const store = {
    onChange: vi.fn(async (cb: Cb) => (cbs.push(cb), () => {})),
    set: vi.fn(async (k: string, v: unknown) => cbs.forEach((cb) => cb(k, v))),
    save: vi.fn(async () => {}),
  };
  return store as typeof store & Store;
}

describe("store compartilhado entre janelas", () => {
  it("a outra janela recebe a mudança; quem gravou ignora o eco", async () => {
    const p = plugin();
    const [a, b] = [vi.fn(), vi.fn()];
    const wa = shareStore(p, a);
    shareStore(p, b);
    await wa.set("tabBar", true);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledExactlyOnceWith("tabBar", true);
  });

  it("valor diferente vindo de outra janela vale mesmo depois de gravar a chave", async () => {
    const p = plugin();
    const a = vi.fn();
    const wa = shareStore(p, a);
    const wb = shareStore(p, vi.fn());
    await wa.set("recent", ["x"]);
    await wb.set("recent", ["y", "x"]);
    expect(a).toHaveBeenCalledExactlyOnceWith("recent", ["y", "x"]);
  });

  it("gravações cruzadas: todas as janelas terminam com a última", async () => {
    const cbs: Cb[] = [];
    const written: [string, unknown][] = [];
    const store = {
      onChange: async (cb: Cb) => (cbs.push(cb), () => {}),
      set: async (k: string, v: unknown) => void written.push([k, v]),
      save: async () => {},
    } as unknown as Store;
    const seen: unknown[][] = [[], []];
    const win = [0, 1].map((i) => shareStore(store, (_k, v) => seen[i].push(v)));
    await win[0].set("k", 1);
    await win[1].set("k", 2);
    for (const [k, v] of written) cbs.forEach((cb) => cb(k, v));
    expect(seen[0]).toEqual([2]);
    expect(seen[1]).not.toContain(1);
  });

  it("sem aviso de mudança no store, grava do mesmo jeito", async () => {
    const p = { ...plugin(), onChange: undefined } as unknown as ReturnType<typeof plugin>;
    const w = shareStore(p, vi.fn());
    await w.set("k", 1);
    await w.save();
    expect(p.set).toHaveBeenCalledWith("k", 1);
    expect(p.save).toHaveBeenCalled();
  });
});
