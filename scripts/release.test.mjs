import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METAINFO, release, tagArgs } from "./release.mjs";

function fixture(version = "0.1.0", unreleased = "### Adicionado\n- coisa\n") {
  const root = mkdtempSync(join(tmpdir(), "rel-"));
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gera-view-image", version }, null, 2) + "\n");
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "X", version }, null, 2) + "\n");
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "gera-view-image", version, lockfileVersion: 3, packages: { "": { name: "gera-view-image", version } } }, null, 2) + "\n",
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "gera-view-image"\nversion = "${version}"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1" }\n`,
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.lock"),
    `[[package]]\nname = "outro"\nversion = "${version}"\n\n[[package]]\nname = "gera-view-image"\nversion = "${version}"\n`,
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n## [Não lançado]\n\n${unreleased}\n## [0.1.0] - 2026-01-01\n- antiga\n`,
  );
  return root;
}
const run = (root, v, extra = {}) => release(v, { root, git: false, today: "2026-11-20", ...extra });

test("rejeita versão não SemVer", () => {
  assert.throws(() => run(fixture(), "1.0"), /SemVer/);
  assert.throws(() => run(fixture(), "v1.0.0"), /SemVer/);
});

test("rejeita versão menor", () => {
  assert.throws(() => run(fixture("0.2.0"), "0.1.9"), /maior/);
});

test("sincroniza os três arquivos", () => {
  const root = fixture();
  run(root, "0.2.0");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version, "0.2.0");
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  assert.match(cargo, /\[package\]\nname = "gera-view-image"\nversion = "0.2.0"/);
  assert.match(cargo, /serde = \{ version = "1" \}/);
  const lock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  assert.match(lock, /name = "gera-view-image"\nversion = "0.2.0"/);
  assert.match(lock, /name = "outro"\nversion = "0.1.0"/);
});

test("move seção Não lançado no CHANGELOG com data", () => {
  const root = fixture();
  run(root, "0.2.0");
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(log, /## \[Não lançado\]\n\n## \[0\.2\.0\] - 2026-11-20\n\n### Adicionado\n- coisa/);
  assert.match(log, /## \[0\.1\.0\] - 2026-01-01/);
});

test("aceita versão igual sem tag", () => {
  const root = fixture("0.1.0");
  run(root, "0.1.0", { tagExists: () => false });
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(log, /## \[0\.1\.0\] - 2026-11-20\n\n### Adicionado/);
});

test("rejeita versão igual com tag existente", () => {
  assert.throws(() => run(fixture("0.1.0"), "0.1.0", { tagExists: () => true }), /tag/);
});

test("rejeita versão menor mesmo sem tag", () => {
  assert.throws(() => run(fixture("0.2.0"), "0.1.0", { tagExists: () => false }), /maior/);
});

test("rejeita árvore suja", () => {
  assert.throws(() => run(fixture(), "0.2.0", { isDirty: () => true }), /sujo|suja|commit/i);
});

test("rejeita seção Não lançado vazia e não altera nada", () => {
  const root = fixture("0.1.0", "");
  assert.throws(() => run(root, "0.2.0"), /vazia/);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.1.0");
});

test("atualiza o package-lock (raiz e packages[\"\"])", () => {
  const root = fixture();
  run(root, "0.2.0");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.2.0");
  assert.equal(lock.packages[""].version, "0.2.0");
});

test("prerelease é menor que a versão final", () => {
  run(fixture("0.2.0-beta.1"), "0.2.0");
  assert.throws(() => run(fixture("0.2.0"), "0.2.0-beta.1", { tagExists: () => false }), /maior/);
  run(fixture("0.2.0-beta.1"), "0.2.0-beta.2");
});

test("a tag de release é anotada (a leve não sobe com --follow-tags)", () => {
  assert.deepEqual(tagArgs("0.2.0"), ["tag", "-a", "v0.2.0", "-m", "v0.2.0"]);
});

test("acrescenta o release no metainfo, se houver", () => {
  const root = fixture();
  const path = join(root, METAINFO);
  mkdirSync(join(root, "src-tauri/linux"));
  writeFileSync(path, '<component>\n  <releases>\n    <release version="0.1.0" date="2026-01-01"/>\n  </releases>\n</component>\n');
  run(root, "0.2.0");
  assert.equal(
    readFileSync(path, "utf8"),
    '<component>\n  <releases>\n    <release version="0.2.0" date="2026-11-20"/>\n    <release version="0.1.0" date="2026-01-01"/>\n  </releases>\n</component>\n',
  );
});

test("release na mesma versão não repete o release no metainfo", () => {
  const root = fixture();
  const path = join(root, METAINFO);
  mkdirSync(join(root, "src-tauri/linux"));
  const xml = '<releases>\n    <release version="0.1.0" date="2026-01-01"/>\n</releases>\n';
  writeFileSync(path, xml);
  run(root, "0.1.0");
  assert.equal(readFileSync(path, "utf8"), xml);
});
