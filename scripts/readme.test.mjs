// README e metainfo: toda imagem e todo link local existem; prints do AppStream estão em docs/screenshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BEGIN, END } from "./shortcuts-table.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const metainfo = readFileSync(join(root, "src-tauri/linux/io.github.junior9283.geraviewimage.metainfo.xml"), "utf8");
const RAW = "https://raw.githubusercontent.com/junior9283/gera-view-image/main/";

/** Alvos locais de `![..](x)`, `[..](x)` e `<img src="x">` (sem URLs nem âncoras). */
function localTargets(md) {
  const md2 = md.replace(/```[\s\S]*?```/g, "");
  const all = [...md2.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g), ...md2.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  return all.filter((t) => !/^(https?:|mailto:|#)/.test(t)).map((t) => t.split("#")[0]);
}

test("toda imagem e todo link local do README existem", () => {
  const targets = localTargets(readme);
  assert.ok(targets.length > 10);
  const missing = targets.filter((t) => !existsSync(join(root, t)));
  assert.deepEqual(missing, []);
});

test("os prints do README são pequenos (cada um < 400 kB, todos < 3 MB)", () => {
  const shots = localTargets(readme).filter((t) => t.startsWith("docs/screenshots/"));
  let total = 0;
  for (const s of new Set(shots)) {
    const size = statSync(join(root, s)).size;
    assert.ok(size < 400_000, `${s} tem ${size} bytes`);
    total += size;
  }
  assert.ok(total < 3_000_000, `prints somam ${total} bytes`);
});

test("âncoras internas do README apontam para títulos existentes", () => {
  const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");
  const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  const used = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(used.filter((a) => !anchors.has(a)), []);
});

test("README sem itens removidos ou desatualizados", () => {
  assert.doesNotMatch(readme, /Abrir Recente/);
  assert.doesNotMatch(readme, /em desenvolvimento|ainda não está completa/i);
  assert.ok(readme.includes(BEGIN) && readme.includes(END));
});

test("prints do metainfo apontam para arquivos do repositório", () => {
  const images = [...metainfo.matchAll(/<image>([^<]+)<\/image>/g)].map((m) => m[1]);
  assert.ok(images.length >= 2);
  for (const url of images) {
    assert.ok(url.startsWith(RAW), url);
    assert.ok(existsSync(join(root, url.slice(RAW.length))), url);
  }
});
