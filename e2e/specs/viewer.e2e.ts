import { browser, $, $$, expect } from "@wdio/globals";
import { Key } from "webdriverio";

const scale = async () => Number(await $('[data-testid="zoom-level"]').getAttribute("data-scale"));
const activeName = () => $(".titlebar-title").getText();

describe("visualizador", () => {
  before(async () => {
    // Os 3 arquivos de argv chegam pelo startup_documents.
    await browser.waitUntil(async () => (await $$(".sidebar-item[data-doc-index]").length) === 3, { timeout: 20000 });
  });

  it("o erro aparece só no item ruim", async () => {
    expect(await $$('[data-testid="thumb-error"]').length).toBe(1);
    expect(await activeName()).toBe("alpha.png");
    expect(await $('[data-testid="doc-error"]').isExisting()).toBe(false);
  });

  it("→ navega até o arquivo truncado e mostra o erro com o nome", async () => {
    await browser.keys(Key.ArrowRight);
    const err = $('[data-testid="doc-error"]');
    await err.waitForExist({ timeout: 5000 });
    expect(await err.getText()).toContain("truncado.jpg");
  });

  it("→ segue navegável depois do erro", async () => {
    await browser.keys(Key.ArrowRight);
    await browser.waitUntil(async () => (await activeName()) === "img.svg", { timeout: 5000 });
    expect(await $('[data-testid="doc-error"]').isExisting()).toBe(false);
  });

  it("Ctrl+0 e Ctrl+9 mudam a escala exibida", async () => {
    await browser.waitUntil(async () => (await scale()) > 0, { timeout: 5000 });
    await browser.keys([Key.Ctrl, "0"]);
    await browser.waitUntil(async () => (await scale()) === 1, { timeout: 5000 });
    await browser.keys([Key.Ctrl, "9"]);
    await browser.waitUntil(async () => (await scale()) < 1, { timeout: 5000 });
  });
});
