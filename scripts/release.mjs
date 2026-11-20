#!/usr/bin/env node
// Uso: npm run release <versão>   (ex.: npm run release 0.2.0)
// Sincroniza a versão em package.json, tauri.conf.json, Cargo.toml/Cargo.lock,
// fecha a seção "Não lançado" do CHANGELOG, faz commit e cria a tag. Não faz push.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const parse = (v) => v.split(/[-+]/)[0].split(".").map(Number);

function isGreater(a, b) {
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

const edit = (path, fn) => writeFileSync(path, fn(readFileSync(path, "utf8")));

export function release(version, { root, git = true, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!SEMVER.test(version ?? "")) throw new Error(`Versão "${version}" não é SemVer (ex.: 0.2.0).`);
  const pkgPath = join(root, "package.json");
  const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (!isGreater(version, current)) throw new Error(`A versão ${version} deve ser maior que a atual (${current}).`);

  const setJsonVersion = (path) => edit(path, (s) => s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
  setJsonVersion(pkgPath);
  setJsonVersion(join(root, "src-tauri/tauri.conf.json"));

  // Só o primeiro `version =` após [package], sem tocar nas dependências.
  edit(join(root, "src-tauri/Cargo.toml"), (s) =>
    s.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`),
  );
  edit(join(root, "src-tauri/Cargo.lock"), (s) =>
    s.replace(/(name = "gera-view-image"\nversion = ")[^"]+(")/, `$1${version}$2`),
  );

  edit(join(root, "CHANGELOG.md"), (s) => {
    const head = "## [Não lançado]";
    if (!s.includes(head)) throw new Error(`CHANGELOG.md sem a seção "${head}".`);
    return s.replace(head, `${head}\n\n## [${version}] - ${today}`);
  });

  if (git) {
    const sh = (...args) => execFileSync("git", args, { cwd: root, stdio: "inherit" });
    sh("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CHANGELOG.md");
    sh("commit", "-m", `chore(release): v${version}`);
    sh("tag", `v${version}`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const v = release(process.argv[2], { root });
    console.log(`Versão v${v} criada (commit + tag). Publique com: git push --follow-tags`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
