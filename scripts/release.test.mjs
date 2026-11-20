import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { release } from "./release.mjs";

function fixture(version = "0.1.0") {
  const root = mkdtempSync(join(tmpdir(), "rel-"));
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gera-view-image", version }, null, 2) + "\n");
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ productName: "X", version }, null, 2) + "\n");
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
    `# Changelog\n\n## [Não lançado]\n\n### Adicionado\n- coisa\n\n## [0.1.0] - 2026-01-01\n- antiga\n`,
  );
  return root;
}
const run = (root, v) => release(v, { root, git: false, today: "2026-11-20" });

test("rejeita versão não SemVer", () => {
  assert.throws(() => run(fixture(), "1.0"), /SemVer/);
  assert.throws(() => run(fixture(), "v1.0.0"), /SemVer/);
});

test("rejeita versão menor ou igual", () => {
  assert.throws(() => run(fixture("0.2.0"), "0.2.0"), /maior/);
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
