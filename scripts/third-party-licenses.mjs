#!/usr/bin/env node
// Gera THIRD_PARTY_LICENSES: licenças de tudo o que vai dentro dos pacotes, ou seja, as crates
// de produção (sem dev/build), as bibliotecas C embutidas por crates -sys (libheif, libwebp…) e
// as dependências npm de produção (o frontend empacotado). Textos idênticos aparecem uma vez só.
// Uso: npm run licenses (rode depois de mudar dependências e commite o resultado).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

/** Arquivos de licença em `dir`; em crates -sys desce até `depth` níveis (fonte C vendorizada). */
function licenseFiles(dir, depth = 0) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isFile() && LICENSE_FILE.test(e.name) && statSync(p).size < 200_000) out.push(p);
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith(".") && !/^(tests?|examples?|docs?|fuzz)$/.test(e.name))
      out.push(...licenseFiles(p, depth - 1));
  }
  return out;
}

function rustComponents() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-unknown-linux-gnu",
        "--manifest-path", join(root, "src-tauri/Cargo.toml")],
      { maxBuffer: 1 << 28, encoding: "utf8" },
    ),
  );
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps) {
      // Só dependências normais: dev e build não vão para o binário.
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  return [...seen].map((id) => {
    const p = pkgs.get(id);
    const dir = dirname(p.manifest_path);
    const vendored = /-(sys|src)$/.test(p.name);
    return {
      name: `${p.name} ${p.version} (Rust)`,
      license: p.license ?? (p.license_file ? `ver ${p.license_file}` : "não declarada"),
      files: licenseFiles(dir, vendored ? 3 : 0).map((f) => ({ path: f, label: relative(dir, f) })),
    };
  });
}

/** Pasta instalada de `key` (`node_modules/...`): na raiz ou numa pasta acima (worktrees). */
function installed(key) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, key, "package.json"))) return join(dir, key);
    if (dirname(dir) === dir) return null;
  }
}

/** Dependências npm de produção pelo package-lock (as `dev` não vão para o bundle). */
function npmComponents() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([key, p]) => key && !p.dev && !p.link)
    .map(([key, p]) => {
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      const dir = installed(key);
      return {
        name: `${name} ${p.version} (npm)`,
        license: p.license ?? "não declarada",
        files: dir ? licenseFiles(dir).map((f) => ({ path: f, label: relative(dir, f) })) : [],
      };
    });
}

const components = [...rustComponents(), ...npmComponents()].sort((a, b) => a.name.localeCompare(b.name));
const texts = new Map(); // texto normalizado -> { text, users: [] }
for (const c of components) {
  for (const f of c.files) {
    const text = readFileSync(f.path, "utf8").replace(/\r\n/g, "\n").trim();
    const key = text.replace(/\s+/g, " ");
    if (!texts.has(key)) texts.set(key, { text, users: [] });
    texts.get(key).users.push(`${c.name}: ${f.label}`);
  }
}

const lines = [
  "Gera View Image — licenças de terceiros",
  "",
  "Este arquivo é gerado por scripts/third-party-licenses.mjs. Lista os componentes incluídos nos",
  "pacotes (crates Rust, bibliotecas C compiladas por crates -sys e dependências npm do frontend)",
  "e os textos das licenças. Bibliotecas do sistema carregadas em tempo de execução (GTK, WebKitGTK,",
  "libaom, e as opcionais libde265 e libkvazaar) seguem as licenças dos seus próprios pacotes.",
  "",
  "== Componentes ==",
  "",
  ...components.map((c) => `${c.name} — ${c.license}`),
  "",
  "== Textos das licenças ==",
];
for (const { text, users } of texts.values()) {
  lines.push("", "-".repeat(78), ...users.map((u) => `* ${u}`), "", text);
}
const dest = join(root, "THIRD_PARTY_LICENSES");
writeFileSync(dest, `${lines.join("\n")}\n`);
const missing = components.filter((c) => !c.files.length).length;
console.log(`${dest}: ${components.length} componentes, ${texts.size} textos (${missing} sem arquivo de licença)`);
if (!existsSync(dest)) process.exit(1);
