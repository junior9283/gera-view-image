import { browser, $, $$, expect } from "@wdio/globals";
import { Key } from "webdriverio";

// Marcação: seta, texto e lupa; desfazer/refazer; achatar (Op::Composite) e conferir o pixel.
// O "exportar PNG" confere o resultado achatado pelo render_view: o comando de exportar é da Task 11.
// Requer o build com VITE_E2E=1 (gancho window.__gviMarkup; ver docs/testes/guia.md).

interface Hook {
  activeId(): number | null;
  count(): number;
  texts(): string[];
  flatten(): Promise<boolean>;
}
declare global {
  interface Window {
    __gviMarkup: Hook;
    __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<ArrayBuffer> };
  }
}

const activeName = async () => String(await $('.sidebar-item[aria-current="true"] .sidebar-name').getProperty("textContent"));
const count = () => browser.execute(() => window.__gviMarkup.count());
const scale = async () => Number(await $('[data-testid="zoom-level"]').getAttribute("data-scale"));

/** Arrasta sobre a camada, em px relativos ao centro dela. */
async function drag(from: [number, number], to: [number, number]) {
  const layer = await $('[data-testid="markup-layer"]');
  await browser
    .action("pointer")
    .move({ origin: layer, x: from[0], y: from[1] })
    .down()
    .move({ origin: layer, x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2, duration: 50 })
    .move({ origin: layer, x: to[0], y: to[1], duration: 50 })
    .up()
    .perform();
}

async function pickShape(kind: string) {
  await $('[data-testid="markup-shapes"]').click();
  await $(`[data-testid="markup-shape-${kind}"]`).click();
}

describe("marcação", () => {
  before(async () => {
    await browser.waitUntil(async () => (await $$(".sidebar-item[data-doc-index]").length) === 3, { timeout: 20000 });
    // img.svg (2048×1024): imagem grande o bastante para desenhar.
    for (const name of ["truncado.jpg", "img.svg"]) {
      await browser.keys(Key.ArrowRight);
      await browser.waitUntil(async () => (await activeName()) === name, { timeout: 5000 });
    }
    await browser.waitUntil(async () => (await scale()) > 0, { timeout: 5000 });
  });

  it("Ctrl+Shift+M mostra a barra de Marcação", async () => {
    await browser.keys([Key.Ctrl, Key.Shift, "m"]);
    await $('[data-testid="markup-bar"]').waitForExist({ timeout: 5000 });
    // A barra encolhe a camada na hora, mas a view só a acompanha no quadro seguinte (ResizeObserver).
    // Num CI lento o arrasto começava com a view antiga e a seta saía inclinada.
    await browser.executeAsync((done: () => void) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });

  it("desenha uma seta, um texto e uma lupa", async () => {
    await pickShape("arrow");
    await drag([-120, -40], [120, -40]);
    await browser.waitUntil(async () => (await count()) === 1, { timeout: 3000 });

    await $('[data-testid="markup-text"]').click();
    await drag([-60, 60], [-60, 60]);
    const editor = await $(".markup-text-editor");
    await editor.waitForExist({ timeout: 3000 });
    await browser.keys("Oi");
    // Sair do campo confirma o texto (o texto novo só entra no histórico aqui).
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await editor.waitForExist({ reverse: true, timeout: 3000 });
    await browser.waitUntil(async () => (await browser.execute(() => window.__gviMarkup.texts())).includes("Oi"), {
      timeout: 3000,
      timeoutMsg: "o texto Oi não foi confirmado",
    });
    expect(await count()).toBe(2);

    await pickShape("loupe");
    await drag([200, 80], [200, 80]);
    await browser.waitUntil(async () => (await count()) === 3, { timeout: 3000 });
  });

  it("desfaz e refaz", async () => {
    await $('[data-testid="viewport"]').click({ x: 0, y: -200 }); // foco fora do texto
    await browser.keys([Key.Ctrl, "z"]);
    await browser.waitUntil(async () => (await count()) === 2, { timeout: 3000 });
    await browser.keys([Key.Ctrl, Key.Shift, "z"]);
    await browser.waitUntil(async () => (await count()) === 3, { timeout: 3000 });
  });

  it("achata e o pixel no centro da seta tem a cor do traço", async () => {
    const s = await scale();
    expect(await browser.execute(() => window.__gviMarkup.flatten())).toBe(true);
    expect(await count()).toBe(0);
    // Centro da seta: centro da imagem (ajustada e centralizada) 40 px de tela acima.
    const [x, y] = [1024, Math.round(512 - 40 / s)];
    const rgba = await browser.executeAsync(
      (x: number, y: number, done: (v: number[]) => void) => {
        const id = window.__gviMarkup.activeId();
        window.__TAURI_INTERNALS__
          .invoke("render_view", { id, frame: 0, maxW: 1, maxH: 1, region: { x, y, w: 1, h: 1 } })
          .then((buf) => done(Array.from(new Uint8Array(buf).slice(8, 12))))
          .catch(() => done([]));
      },
      x,
      y,
    );
    // Cor padrão do traço: #ff3b30. Se não for, diz onde a seta ficou (já falhou uma vez no CI sem explicar).
    if (rgba[1] !== 0x3b) {
      const onde = await browser.executeAsync((done: (v: unknown) => void) => {
        const id = window.__gviMarkup.activeId();
        const box = (q: string) => JSON.stringify(document.querySelector(q)?.getBoundingClientRect());
        window.__TAURI_INTERNALS__
          .invoke("render_view", { id, frame: 0, maxW: 1, maxH: 1024, region: { x: 1024, y: 0, w: 1, h: 1024 } })
          .then((buf) => {
            const px = new Uint8Array(buf).slice(8);
            const linhas = Array.from({ length: px.length / 4 }, (_, i) => i).filter((i) => px[i * 4] > 200 && px[i * 4 + 1] < 140);
            done({ linhas, camada: box('[data-testid="markup-layer"]'), barra: box('[data-testid="markup-bar"]') });
          })
          .catch((e) => done(String(e)));
      });
      console.error("seta fora do lugar:", JSON.stringify({ x, y, escala: s, escalaAgora: await scale(), rgba, onde }));
    }
    expect(rgba).toEqual([0xff, 0x3b, 0x30, 255]);
  });
});
