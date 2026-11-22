import { describe, expect, it } from "vitest";
import { track, whenIdle } from "./inflight";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

describe("comandos em andamento", () => {
  it("espera o comando que altera o documento, por id ou ids, com sucesso ou falha", async () => {
    const a = deferred();
    const b = deferred();
    track("apply_op", { id: 1 }, a.promise);
    track("um_comando_novo", { ids: [2, 3] }, b.promise).catch(() => {});
    expect(await whenIdle([1], 0)).toBe(false);
    expect(await whenIdle([3], 0)).toBe(false);
    expect(await whenIdle([9], 0)).toBe(true);
    a.resolve();
    b.reject(new Error("x"));
    expect(await whenIdle([1, 2, 3], 1000)).toBe(true);
  });

  it("leitura não segura", async () => {
    const r = deferred();
    track("render_view", { id: 5 }, r.promise);
    expect(await whenIdle([5], 0)).toBe(true);
    r.resolve();
  });

  it("comando encadeado na resposta do anterior também é esperado", async () => {
    const first = deferred();
    const second = deferred();
    void track("apply_op", { id: 6 }, first.promise).then(() => track("save", { id: 6 }, second.promise));
    first.resolve();
    expect(await whenIdle([6], 0)).toBe(false);
    second.resolve();
    expect(await whenIdle([6], 1000)).toBe(true);
  });

  it("inclusive o que só começa na vez seguinte do navegador", async () => {
    const later = deferred();
    const idle = whenIdle([7], 0);
    setTimeout(() => void track("apply_op", { id: 7 }, later.promise), 0);
    expect(await idle).toBe(false);
    later.resolve();
  });
});
