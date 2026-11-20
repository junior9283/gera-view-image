#!/usr/bin/env node
// Uso: npm run release <versão>   (ex.: npm run release 0.2.0)
// Sincroniza a versão em package.json, tauri.conf.json, Cargo.toml/Cargo.lock,
// fecha a seção "Não lançado" do CHANGELOG, faz commit e cria a tag. Não faz push.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compara SemVer 2.0 (ignora build metadata): -1, 0 ou 1. Prerelease < versão final. */
function compare(a, b) {
  const split = (v) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s);
    return [core.split(".").map(Number), pre ? pre.split(".") : null];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] > cb[i] ? 1 : -1;
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

const edit = (path, fn) => writeFileSync(path, fn(readFileSync(path, "utf8")));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
/** Tag anotada: `git push --follow-tags` ignora tags leves. */
export const tagArgs = (version) => ["tag", "-a", `v${version}`, "-m", `v${version}`];
const HEAD = "## [Não lançado]";

export function release(
  version,
  {
    root,
    git: useGit = true,
    today = new Date().toISOString().slice(0, 10),
    isDirty = () => useGit && git(root, "status", "--porcelain").trim() !== "",
    tagExists = (tag) => useGit && git(root, "tag", "-l", tag).trim() !== "",
  } = {},
) {
  if (!SEMVER.test(version ?? "")) throw new Error(`Versão "${version}" não é SemVer (ex.: 0.2.0).`);
  const pkgPath = join(root, "package.json");
  const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  const cmp = compare(version, current);
  // Igual à atual só vale para o primeiro release (a versão já está no repositório e a tag ainda não existe).
  if (cmp < 0) throw new Error(`A versão ${version} deve ser maior que a atual (${current}).`);
  if (cmp === 0 && tagExists(`v${version}`)) throw new Error(`A tag v${version} já existe: use uma versão maior que ${current}.`);
  if (isDirty()) throw new Error("Árvore de trabalho suja: faça commit ou descarte as mudanças antes do release.");

  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  const at = changelog.indexOf(HEAD);
  if (at < 0) throw new Error(`CHANGELOG.md sem a seção "${HEAD}".`);
  const body = changelog.slice(at + HEAD.length).split(/^## \[/m)[0];
  if (!body.trim()) throw new Error(`A seção "${HEAD}" está vazia: descreva as mudanças antes do release.`);

  const setJsonVersion = (path) => edit(path, (s) => s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
  setJsonVersion(pkgPath);
  setJsonVersion(join(root, "src-tauri/tauri.conf.json"));
  edit(join(root, "package-lock.json"), (s) => {
    const lock = JSON.parse(s);
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    return JSON.stringify(lock, null, 2) + "\n";
  });

  // Só o primeiro `version =` após [package], sem tocar nas dependências.
  edit(join(root, "src-tauri/Cargo.toml"), (s) =>
    s.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`),
  );
  edit(join(root, "src-tauri/Cargo.lock"), (s) =>
    s.replace(/(name = "gera-view-image"\nversion = ")[^"]+(")/, `$1${version}$2`),
  );
  writeFileSync(changelogPath, changelog.replace(HEAD, `${HEAD}\n\n## [${version}] - ${today}`));

  if (useGit) {
    git(root, "add", "package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CHANGELOG.md");
    git(root, "commit", "-m", `chore(release): v${version}`);
    git(root, ...tagArgs(version));
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
