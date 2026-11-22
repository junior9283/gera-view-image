import { browser, $, $$, expect } from "@wdio/globals";

// Janelas e Abas: mover a aba para uma janela nova, navegar sem roubar o foco e juntar de volta.
// Requer o build com VITE_E2E=1 (gancho window.__gviE2E).

const items = () => $$(".sidebar-item[data-doc-index]").length;
const run = (id: string) =>
  browser.execute((c) => (window as unknown as { __gviE2E: { run(c: string): boolean } }).__gviE2E.run(c), id);
const titles = () =>
  browser.executeAsync((done: (t: { title: string }[]) => void) => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke(c: string): Promise<{ title: string }[]> } };
    void w.__TAURI_INTERNALS__.invoke("list_windows").then(done);
  });

describe("várias janelas", () => {
  let main = "";

  before(async () => {
    await browser.waitUntil(async () => (await items()) === 3, { timeout: 20000 });
    main = await browser.getWindowHandle();
  });

  it("Mover Aba para Nova Janela leva o documento, e as duas janelas são controláveis", async () => {
    expect(await run("window.moveTabToNewWindow")).toBe(true);
    await browser.waitUntil(async () => (await titles()).length === 2, { timeout: 20000 });
    await browser.waitUntil(async () => (await items()) === 2, { timeout: 20000 });
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, { timeout: 20000 });
    const other = (await browser.getWindowHandles()).find((h) => h !== main);
    await browser.switchToWindow(other ?? "");
    await $('[data-testid="zoom-level"]').waitForExist({ timeout: 20000 });
    // O título chega quando a janela nova mostra o documento.
    await browser.waitUntil(async () => (await titles()).some((w) => w.title === "alpha.png"), { timeout: 10000 });
  });

  it("Juntar Todas as Janelas traz o documento de volta e fecha a outra", async () => {
    await browser.switchToWindow(main);
    expect(await run("window.mergeAllWindows")).toBe(true);
    await browser.waitUntil(async () => (await items()) === 3, { timeout: 20000 });
    await browser.waitUntil(async () => (await titles()).length === 1, { timeout: 20000 });
  });
});
