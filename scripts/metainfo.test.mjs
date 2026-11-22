// AppStream: o metainfo vai nos três pacotes, é válido e acompanha o CHANGELOG e o .desktop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const FILE = `linux/${conf.identifier}.metainfo.xml`;
const xml = read(`src-tauri/${FILE}`);
const template = read("src-tauri/linux/gera-view-image.desktop.hbs");
const has = (bin) => spawnSync(bin, ["--version"]).status === 0;

test("o metainfo vai no .deb, no .rpm e no AppImage", () => {
  const dest = `/usr/share/metainfo/${conf.identifier}.metainfo.xml`;
  for (const kind of ["deb", "rpm", "appimage"]) assert.equal(conf.bundle.linux[kind]?.files?.[dest], FILE, kind);
});

test("id, licença, página, descrição nos dois idiomas e .desktop que o pacote instala", () => {
  assert.match(xml, new RegExp(`<id>${conf.identifier}</id>`));
  assert.match(xml, /<project_license>MIT<\/project_license>/);
  assert.match(xml, /<url type="homepage">https:\/\/github\.com\/junior9283\/gera-view-image<\/url>/);
  assert.match(xml, /<summary xml:lang="pt_BR">/);
  assert.match(xml, /<p xml:lang="pt_BR">/);
  assert.match(xml, new RegExp(`<launchable type="desktop-id">${conf.productName}\\.desktop</launchable>`));
});

test("releases: os mesmos do CHANGELOG, o mais novo primeiro", () => {
  const log = [...read("CHANGELOG.md").matchAll(/^## \[(\d[^\]]*)\] - (\S+)/gm)].map((m) => [m[1], m[2]]);
  const rel = [...xml.matchAll(/<release version="([^"]+)" date="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rel, log);
});

test("os tipos que o .desktop abre estão no metainfo", () => {
  const mimes = /^MimeType=(.*)$/m.exec(template)[1].split(";").filter(Boolean);
  assert.deepEqual([...xml.matchAll(/<mediatype>([^<]+)</g)].map((m) => m[1]), mimes);
});

test("o .desktop tem palavras-chave nos dois idiomas", () => {
  assert.match(template, /^Keywords=.*;$/m);
  assert.match(template, /^Keywords\[pt_BR\]=.*;$/m);
});

test("appstreamcli aceita o metainfo", { skip: !has("appstreamcli") }, () => {
  const r = spawnSync("appstreamcli", ["validate", "--no-net", join(root, "src-tauri", FILE)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("desktop-file-validate aceita o .desktop", { skip: !has("desktop-file-validate") }, () => {
  const f = join(mkdtempSync(join(tmpdir(), "gvi-desktop-")), "app.desktop");
  writeFileSync(f, template.replace("{{exec}}", "gera-view-image").replace("{{icon}}", "gera-view-image"));
  const r = spawnSync("desktop-file-validate", [f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
