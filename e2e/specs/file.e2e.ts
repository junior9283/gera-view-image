import { browser, $, $$, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Cópia descartável de "Ação 1.jpg" (16×12) numa pasta com espaço e acento, preparada no
// `beforeSession` do wdio.conf.ts para este spec (o arquivo é regravado pelo teste).
const file = process.env.GVI_E2E_FILE!;

/** Dimensões gravadas no JPEG (marcador SOF), sem decodificar. */
function jpegSize(p: string): { w: number; h: number } {
  const b = readFileSync(p);
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("JPEG sem SOF");
}

const scale = async () => Number(await $('[data-testid="zoom-level"]').getAttribute("data-scale"));

async function menuItem(menu: number, labels: string[]) {
  await $$(".menubar-button")[menu].click();
  const items = await $$(".menu-level-0 .menu-item");
  for (const it of items) {
    const text = (await it.$(".menu-label").getText()).trim();
    if (labels.includes(text)) return it.click();
  }
  throw new Error(`item de menu não encontrado: ${labels.join(" / ")}`);
}

describe("arquivo", () => {
  before(async () => {
    expect(existsSync(file)).toBe(true);
    await browser.waitUntil(async () => (await scale()) > 0, { timeout: 20000 });
  });

  it("girar e fechar mostra o diálogo de não salvo; Cancelar mantém o documento", async () => {
    await browser.keys([Key.Ctrl, "r"]);
    await browser.keys([Key.Ctrl, "w"]);
    const dlg = $('[data-testid="unsaved-dialog"]');
    await dlg.waitForExist({ timeout: 5000 });
    expect(await dlg.getText()).toContain("Ação 1.jpg");
    const buttons = await dlg.$$("button");
    // Ordem: Não Salvar, Cancelar, Salvar.
    await buttons[1].click();
    await dlg.waitForExist({ timeout: 5000, reverse: true });
    expect(await scale()).toBeGreaterThan(0);
    expect(jpegSize(file)).toEqual({ w: 16, h: 12 });
  });

  it("Salvar grava girado no próprio arquivo", async () => {
    await browser.keys([Key.Ctrl, "s"]);
    await browser.waitUntil(() => jpegSize(file).w === 12, { timeout: 10000, timeoutMsg: "arquivo não foi regravado" });
    expect(jpegSize(file)).toEqual({ w: 12, h: 16 });
    // Sem temporários esquecidos na pasta.
    const dir = path.dirname(file);
    expect(readdirSync(dir).filter((n) => n.includes(".gvi-"))).toEqual([]);
  });

  it("fechar depois de salvar não pergunta nada", async () => {
    await browser.keys([Key.Ctrl, "w"]);
    await $(".viewport-empty").waitForExist({ timeout: 5000 });
    expect(await $('[data-testid="unsaved-dialog"]').isExisting()).toBe(false);
  });

  it("Exportar para WebP cria o arquivo", async () => {
    // Reabre o arquivo salvo pelos Recentes (passa pelo open_documents como o Abrir).
    await menuItem(0, ["Abrir Recentes", "Open Recent"]);
    const recent = $(".file-list button");
    await recent.waitForExist({ timeout: 5000 });
    await recent.click();
    await browser.waitUntil(async () => (await scale()) > 0, { timeout: 10000 });

    await menuItem(0, ["Exportar…", "Export…"]);
    const name = $('[data-testid="export-name"]');
    await name.waitForExist({ timeout: 5000 });
    const format = $(".file-dialog select");
    await format.selectByAttribute("value", "webp");
    const dest = path.join(path.dirname(file), "Exportada ação.webp");
    await name.setValue(path.basename(dest));
    await $('[data-testid="export-ok"]').click();
    await browser.waitUntil(() => existsSync(dest), { timeout: 15000, timeoutMsg: "WebP não foi criado" });
    const head = readFileSync(dest).subarray(0, 12);
    expect(head.subarray(0, 4).toString()).toBe("RIFF");
    expect(head.subarray(8, 12).toString()).toBe("WEBP");
  });
});
