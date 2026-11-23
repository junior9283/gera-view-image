#!/usr/bin/env node
// Prints do README a partir do app real (build release com VITE_E2E=1) sob X virtual.
//
//   env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s "-screen 0 1440x900x24" \
//     sh -c 'openbox & node scripts/screenshots.mjs'
//
// Rode com HOME, XDG_RUNTIME_DIR e o barramento (dbus-run-session) próprios, nunca os da sessão do
// usuário; um gerenciador de janelas (openbox) posiciona a segunda janela. Binário: $GVI_BINARY ou
// $CARGO_TARGET_DIR/release/gera-view-image. Imagens: e2e/demo (scripts/demo-images.mjs), copiadas
// para $GVI_SHOTS_DIR (padrão ~/Imagens), que é o caminho que aparece nos diálogos. Perfil CMYK da
// Prova de Cor: $GVI_SHOTS_ICC (opcional), copiado para ~/.local/share/icc. Saída:
// docs/screenshots/*.png e docs/screenshots/fluxo.gif (se houver ffmpeg).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote, Key } from "webdriverio";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "docs", "screenshots");
const demo = path.join(root, "e2e", "demo");
const binary =
  process.env.GVI_BINARY ??
  path.join(process.env.CARGO_TARGET_DIR ?? path.join(root, "src-tauri", "target"), "release", "gera-view-image");
const PORT = Number(process.env.GVI_E2E_PORT ?? 4448);
const driverPath = process.env.TAURI_DRIVER ?? path.join(os.homedir(), ".cargo", "bin", "tauri-driver");
const isDemo = (f) => /\.(png|tif)$/.test(f);

if (!existsSync(binary)) throw new Error(`binário não encontrado: ${binary}`);
if (!readdirSync(demo).some(isDemo)) spawnSync("node", [path.join(root, "scripts", "demo-images.mjs")]);
mkdirSync(out, { recursive: true });

// Imagens numa pasta de nome neutro (o caminho aparece no Exportar e no Inspetor).
const shotsDir = process.env.GVI_SHOTS_DIR ?? path.join(os.homedir(), "Imagens");
mkdirSync(shotsDir, { recursive: true });
const files = readdirSync(demo)
  .filter(isDemo)
  .sort()
  .map((f) => {
    copyFileSync(path.join(demo, f), path.join(shotsDir, f));
    return path.join(shotsDir, f);
  });
if (process.env.GVI_SHOTS_ICC) {
  const icc = path.join(os.homedir(), ".local", "share", "icc");
  mkdirSync(icc, { recursive: true });
  copyFileSync(process.env.GVI_SHOTS_ICC, path.join(icc, path.basename(process.env.GVI_SHOTS_ICC)));
}

// Preferências e cache isolados numa pasta temporária própria.
const home = mkdtempSync(path.join(os.tmpdir(), "gvi-shots-"));
const lang = process.env.GVI_SHOTS_LANG ?? "pt_BR.UTF-8";
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  LANG: lang,
  LC_ALL: lang,
};
const driver = spawn(driverPath, ["--port", String(PORT), "--native-port", String(PORT + 100)], { env, stdio: "inherit" });
process.on("exit", () => {
  driver.kill();
  rmSync(home, { recursive: true, force: true });
});
await new Promise((r) => setTimeout(r, 1500));

const browser = await remote({
  hostname: "127.0.0.1",
  port: PORT,
  logLevel: "warn",
  capabilities: { "tauri:options": { application: binary, args: files } },
});

const $ = (s) => browser.$(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (id) => browser.execute((id) => window.__gviE2E.run(id), id);
const repaint = () => sleep(700);
const xdo = (...args) => spawnSync("xdotool", args.map(String), { encoding: "utf8" });
/**
 * Captura a janela pelo X (ImageMagick `import`), não pelo WebDriver: o snapshot do WebKitWebDriver
 * devolve o canvas desatualizado sem compositing. Sem `import`, cai no WebDriver. `screen` captura a
 * tela inteira (várias janelas).
 */
async function capture(file, { screen = false } = {}) {
  if (screen) {
    if (spawnSync("import", ["-window", "root", file]).status === 0) return;
  }
  const r = await browser.getWindowRect().catch(() => null);
  const geo = r ? `${r.width}x${r.height}+${Math.max(0, r.x)}+${Math.max(0, r.y)}` : null;
  const ok = geo && spawnSync("import", ["-window", "root", "-crop", geo, "+repage", file]).status === 0;
  if (!ok) await browser.saveScreenshot(file);
}
const shot = async (name, opts) => {
  await repaint();
  await capture(path.join(out, `${name}.png`), opts);
  console.log("print:", name);
};
const setTheme = (t) => browser.execute((t) => (document.documentElement.dataset.theme = t), t);
/** Fecha o diálogo aberto pelo botão Cancelar (Esc não fecha todos). */
async function cancel() {
  const b = await $('//button[normalize-space()="Cancelar" or normalize-space()="Cancel"]');
  if (await b.isExisting()) await b.click();
  else await browser.keys(Key.Escape);
  await sleep(400);
}
const activeName = async () =>
  String(await $('.sidebar-item[aria-current="true"] .sidebar-name').getProperty("textContent"));
async function goTo(name) {
  await run("go.first");
  await sleep(300);
  for (let i = 0; i < files.length && (await activeName()) !== name; i++) {
    await browser.keys(Key.ArrowDown);
    await sleep(300);
  }
  await browser.waitUntil(async () => Number(await $('[data-testid="zoom-level"]').getAttribute("data-scale")) > 0);
}
/** Abre um menu da barra e clica nos itens pelo rótulo (submenus incluídos). */
async function menu(top, ...items) {
  await $(`//button[contains(@class,"menubar-button")][normalize-space()="${top}"]`).click();
  for (const label of items) {
    const it = await $(`//*[contains(@class,"menu-item")][.//span[contains(@class,"menu-label")][normalize-space()="${label}"]]`);
    await it.waitForExist({ timeout: 5000 });
    await it.click();
    await sleep(400);
  }
}
/** Centro do viewport na tela e escala da imagem. */
async function viewportCenter() {
  const [cx, cy] = await browser.execute(() => {
    const r = document.querySelector('[data-testid="viewport"]').getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  const win = await browser.getWindowRect().catch(() => ({ x: 0, y: 0 }));
  return [Math.max(0, win.x) + cx, Math.max(0, win.y) + cy];
}
/**
 * Arrasta pelos pontos dados (px relativos ao centro do viewport) com eventos reais do X
 * (`xdotool`): os movimentos do WebKitWebDriver depois do `down` chegam com coordenadas erradas.
 */
async function stroke(points, { release = true } = {}) {
  const [cx, cy] = await viewportCenter();
  const abs = ([x, y]) => [Math.round(cx + x), Math.round(cy + y)];
  xdo("mousemove", ...abs(points[0]));
  await sleep(100);
  xdo("mousedown", 1);
  for (const p of points.slice(1)) {
    xdo("mousemove", ...abs(p));
    await sleep(25);
  }
  await sleep(100);
  if (release) xdo("mouseup", 1);
}
const drag = (from, to, opts) =>
  stroke([from, ...Array.from({ length: 8 }, (_, i) => [from[0] + ((to[0] - from[0]) * (i + 1)) / 8, from[1] + ((to[1] - from[1]) * (i + 1)) / 8])], opts);
const releaseMouse = () => xdo("mouseup", 1);
/** Janelas X visíveis do app: `[id, título]`. */
const appWindows = () =>
  xdo("search", "--onlyvisible", "--name", ".")
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .map((id) => [id, xdo("getwindowname", id).stdout.trim()]);

// Quadros do GIF (abrir → anotar → exportar).
const frames = path.join(home, "frames");
mkdirSync(frames);
let frameNo = 0;
const frameName = (n) => path.join(frames, `f${String(n).padStart(3, "0")}.png`);
async function frame(repeat = 1) {
  await repaint();
  await capture(frameName(frameNo));
  for (let i = 1; i < repeat; i++) copyFileSync(frameName(frameNo), frameName(frameNo + i));
  frameNo += repeat;
}

try {
  await browser.setWindowSize(1280, 800).catch(() => {});
  await browser.waitUntil(async () => (await browser.$$(".sidebar-item[data-doc-index]").length) === files.length, {
    timeout: 30000,
  });
  await browser.waitUntil(() => browser.execute(() => !!window.__gviE2E), { timeout: 10000 });
  await goTo("04-cartao-postal.png");
  await sleep(1500); // miniaturas
  await frame(4);

  await setTheme("light");
  await shot("01-janela-miniaturas-claro");
  await setTheme("dark");
  await shot("02-janela-miniaturas-escuro");
  await setTheme("light");

  await run("view.contactSheet");
  await $('[data-testid="contact-sheet"]').waitForExist({ timeout: 5000 });
  await shot("03-folha-de-contatos");
  await run("view.thumbnails");
  await sleep(500);

  // Marcação: seta, retângulo, texto e lupa.
  await run("view.fit");
  await run("view.markupBar");
  await $('[data-testid="markup-bar"]').waitForExist({ timeout: 5000 });
  await frame(2);
  const shape = async (kind) => {
    await $('[data-testid="markup-shapes"]').click();
    await $(`[data-testid="markup-shape-${kind}"]`).click();
  };
  await shape("arrow");
  await drag([-260, 120], [-80, 10]);
  await frame(2);
  await shape("rect");
  await drag([120, -230], [330, -60]);
  await frame(2);
  await $('[data-testid="markup-text"]').click();
  await drag([-320, 160], [-320, 160]);
  await $(".markup-text-editor").waitForExist({ timeout: 3000 });
  await browser.keys("Lembranças da ilha!");
  await browser.execute(() => document.activeElement?.blur());
  await frame(2);
  await shape("loupe");
  await drag([200, 165], [200, 165]);
  await frame(3);
  console.log("anotações:", await browser.execute(() => window.__gviMarkup.count()));
  await shot("04-marcacao");

  // Exportar (o diálogo achata as anotações só ao gravar).
  await run("file.export");
  await $('[data-testid="export-ok"]').waitForExist({ timeout: 5000 });
  await frame(4);
  await shot("08-exportar");
  await cancel();
  await frame(2);
  await run("view.markupBar");

  await goTo("01-por-do-sol.png");
  await run("tools.adjustColor");
  await sleep(1200);
  // Prévia ao vivo: mais saturação e temperatura mais quente na própria imagem.
  await browser.execute(() => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const rows = [...document.querySelectorAll("label.adjust-row")];
    const slider = (re) => rows.find((r) => re.test(r.querySelector("span")?.textContent ?? ""))?.querySelector("input");
    const sat = slider(/Satura/);
    const temp = slider(/Temperatura/);
    if (sat) set(sat, Number(sat.max) * 0.6);
    if (temp) set(temp, Number(temp.max) * 0.4);
  });
  await sleep(1200);
  await shot("05-ajustar-cor");
  await cancel();

  await run("tools.resize");
  await sleep(800);
  await shot("06-ajustar-tamanho");
  await cancel();

  // Inspetor: EXIF, GPS e palavras-chave do pôr do sol (metadados fictícios de demo-images.mjs).
  await run("tools.inspector");
  await sleep(1000);
  await $("#inspector-tab-exif").click();
  await shot("07-inspetor");
  await $("#inspector-tab-gps").click();
  await shot("11-inspetor-gps");
  await $("#inspector-tab-keywords").click();
  await shot("12-inspetor-palavras-chave");
  await run("tools.inspector");

  // Prova de Cor com um perfil CMYK instalado (só na tela).
  if (process.env.GVI_SHOTS_ICC) {
    const proofSubmenu = "Prova de Cor com Perfil";
    await menu("Visualizar", proofSubmenu);
    const cmyk = await $(`//*[@role="menuitemradio"][.//span[contains(normalize-space(),"FOGRA")]]`);
    if (await cmyk.isExisting()) {
      await cmyk.click();
      await sleep(1500);
      await menu("Visualizar", proofSubmenu);
      await shot("16-prova-de-cor");
      await browser.keys(Key.Escape);
      await browser.keys(Key.Escape);
      await sleep(300);
      await run("view.softProofNone");
    } else {
      console.log("sem perfil FOGRA no menu: print da Prova de Cor pulado");
      await browser.keys(Key.Escape);
      await browser.keys(Key.Escape);
    }
  }

  await goTo("05-estrela-fundo-liso.png");
  await run("tools.instantAlpha");
  await sleep(300);
  await drag([-330, -200], [-200, -200], { release: false });
  await sleep(1200);
  await shot("09-alfa-instantaneo");
  releaseMouse();
  await browser.keys(Key.Escape);
  await browser.keys(Key.Escape);
  await sleep(300);

  // Laço Inteligente: um contorno solto em volta da estrela gruda na borda ao soltar.
  await run("tools.selectSmartLasso");
  await sleep(300);
  const scale = Number(await $('[data-testid="zoom-level"]').getAttribute("data-scale"));
  const star = Array.from({ length: 73 }, (_, i) => {
    const a = (i / 72) * 2 * Math.PI;
    const r = (180 + 120 * Math.cos(5 * a) + 12) * scale;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  await stroke(star);
  await sleep(1200);
  await shot("18-laco-inteligente");
  await browser.keys(Key.Escape);
  await browser.keys(Key.Escape);
  await sleep(300);

  // TIFF de várias páginas: as páginas aparecem na barra lateral.
  await goTo("06-tres-paginas.tif");
  const page2 = await $('//button[contains(@class,"sidebar-page")][.//span[normalize-space()="Página 2"]]');
  if (await page2.isExisting()) {
    await page2.scrollIntoView();
    await page2.click();
  }
  await sleep(1200);
  await shot("17-tiff-paginas");

  // Abas: barra de abas e Mostrar Todas as Abas.
  await goTo("04-cartao-postal.png");
  await run("view.tabBar");
  await sleep(800);
  await shot("13-barra-de-abas");
  await run("view.allTabs");
  await sleep(1500);
  await shot("14-todas-as-abas");
  await browser.keys(Key.Escape);
  await sleep(400);

  // Duas janelas: a aba ativa vai para uma janela nova; as duas lado a lado na tela.
  await goTo("02-formas.png");
  await run("window.moveTabToNewWindow");
  await sleep(4000);
  const wins = appWindows();
  const mine = await activeName();
  const first = wins.find(([, t]) => t === mine)?.[0];
  const second = wins.find(([id, t]) => id !== first && t)?.[0];
  if (first && second) {
    xdo("windowsize", first, 920, 640);
    xdo("windowmove", first, 30, 30);
    xdo("windowsize", second, 920, 640);
    xdo("windowmove", second, 490, 230);
    xdo("windowactivate", "--sync", second);
    await sleep(2500);
    await shot("15-varias-janelas", { screen: true });
  } else {
    console.log("janela nova não encontrada: print das várias janelas pulado", wins);
  }
  await run("window.mergeAllWindows");
  await sleep(2000);
  await browser.setWindowSize(1280, 800).catch(() => {});
  await browser.setWindowRect(0, 0, 1280, 800).catch(() => {});
  await run("view.tabBar");
  await sleep(600);

  await browser.execute(() =>
    window.__gviE2E.showUpdate({
      version: "0.5.0",
      date: null,
      notes: "## Novidades\n- Várias janelas e abas\n- Prova de Cor com Perfil\n- Importar do Scanner",
    }),
  );
  await shot("10-atualizacao");
} finally {
  await browser.deleteSession().catch(() => {});
}

// GIF curto (abrir → anotar → exportar).
if (spawnSync("which", ["ffmpeg"]).status === 0 && frameNo > 0) {
  const gif = path.join(out, "fluxo.gif");
  const vf = "scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer";
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "2", "-i", path.join(frames, "f%03d.png"), "-vf", vf, gif], {
    stdio: "inherit",
  });
  console.log(r.status === 0 ? `gif: ${gif}` : "ffmpeg falhou");
} else {
  console.log("sem ffmpeg: GIF não gerado");
}
process.exit(0);
