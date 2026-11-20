import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "fix-latest-json.sh");
const base = "https://github.com/junior9283/gera-view-image/releases/download";

/** Grava `json` num arquivo temporário, roda o script e devolve o resultado e o JSON final. */
function run(json, tag = "v1.2.3") {
  const f = join(mkdtempSync(join(tmpdir(), "latest-")), "latest.json");
  writeFileSync(f, JSON.stringify(json));
  const r = spawnSync("bash", [script, f, tag], { encoding: "utf8" });
  return { r, out: JSON.parse(readFileSync(f, "utf8")) };
}

const exemplo = (dir) => ({
  version: "1.2.3",
  notes: "notas",
  platforms: {
    "linux-x86_64": { signature: "sig", url: `${base}/${dir}/gera-view-image_1.2.3_amd64.AppImage` },
    "linux-x86_64-deb": { signature: "sig", url: `${base}/${dir}/gera-view-image_1.2.3_amd64.deb` },
  },
});

test("reescreve URLs untagged-<hash> para a tag", () => {
  const { r, out } = run(exemplo("untagged-0123abcd"));
  assert.equal(r.status, 0, r.stderr);
  for (const p of Object.values(out.platforms)) assert.match(p.url, /\/releases\/download\/v1\.2\.3\//);
  assert.equal(out.notes, "notas");
});

test("mantém URLs que já têm a tag", () => {
  const { r, out } = run(exemplo("v1.2.3"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out, exemplo("v1.2.3"));
});

test("falha se alguma URL aponta para outra tag", () => {
  const { r } = run(exemplo("v0.0.1"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sem a tag v1\.2\.3/);
});

test("falha sem plataformas", () => {
  const { r } = run({ version: "1.2.3", platforms: {} });
  assert.equal(r.status, 1);
});
