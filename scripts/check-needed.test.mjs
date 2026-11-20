import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-needed.sh");

/** Roda o script com um `readelf` falso que lista `libs` como NEEDED. */
function run(libs) {
  const bin = mkdtempSync(join(tmpdir(), "needed-"));
  const lines = libs.map((l) => ` 0x0000000000000001 (NEEDED)             Shared library: [${l}]`).join("\n");
  writeFileSync(join(bin, "readelf"), `#!/bin/sh\ncat <<'EOF'\n${lines}\nEOF\n`);
  chmodSync(join(bin, "readelf"), 0o755);
  return spawnSync("bash", [script, "/qualquer/binario"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

const base = ["libc.so.6", "libm.so.6", "libstdc++.so.6", "libgcc_s.so.1", "libaom.so.3", "libgtk-3.so.0", "libwebkit2gtk-4.1.so.0"];

test("aceita só bibliotecas da allowlist", () => {
  const r = run(base);
  assert.equal(r.status, 0, r.stderr);
});

for (const lib of ["libde265.so.0", "libjpeg.so.8", "libopenjp2.so.7", "libheif.so.1", "libdav1d.so.7", "libx265.so.215"]) {
  test(`recusa ${lib}`, () => {
    const r = run([...base, lib]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`PROIBIDA: ${lib.replace(/\./g, "\\.")}`));
  });
}

test("recusa biblioteca desconhecida", () => {
  const r = run([...base, "libqualquer.so.1"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fora da allowlist: libqualquer\.so\.1/);
});
