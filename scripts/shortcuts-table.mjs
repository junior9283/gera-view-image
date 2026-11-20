#!/usr/bin/env node
// Tabela de atalhos do README gerada de src/shortcuts/keymap.ts (fonte única) e dos rótulos pt-BR.
//   node scripts/shortcuts-table.mjs          imprime a tabela
//   node scripts/shortcuts-table.mjs --write  atualiza o README entre os marcadores
//   node scripts/shortcuts-table.mjs --check  sai com 1 se o README estiver desatualizado
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BEGIN = "<!-- atalhos:inicio (gerado por scripts/shortcuts-table.mjs) -->";
export const END = "<!-- atalhos:fim -->";

/** `{ "id": "Atalho" }` de um bloco `NOME: ... = { ... };` do keymap.ts. */
function parseBlock(src, name) {
  const m = new RegExp(`export const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(src);
  if (!m) throw new Error(`bloco ${name} não encontrado em keymap.ts`);
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^\s*"([\w.]+)":\s*(\[[^\]]*\]|"[^"]*")/.exec(line);
    if (kv) out[kv[1]] = JSON.parse(kv[2]);
  }
  return out;
}

const SYMBOLS = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", Delete: "Del" };
const fmt = (s) => "`" + s.replace(/[^+]+$/, (k) => SYMBOLS[k] ?? k) + "`";

export function buildTable(keymapSrc, labels) {
  const keymap = parseBlock(keymapSrc, "KEYMAP");
  const aliases = parseBlock(keymapSrc, "ALIASES");
  const rows = ["| Menu | Comando | Atalho |", "|---|---|---|"];
  for (const [id, combo] of Object.entries(keymap)) {
    if (!combo) continue;
    const [group, ...rest] = id.split(".");
    const name = rest.join(".");
    const menu = labels.menu[group];
    const label = name.startsWith("annotate.")
      ? `${menu.annotate} ▸ ${menu.annotateKinds[name.slice(9)]}`
      : menu[name];
    const keys = [combo, ...(aliases[id] ?? [])].map(fmt).join(" ou ");
    rows.push(`| ${menu.title} | ${String(label).replace(/…$/, "")} | ${keys} |`);
  }
  return rows.join("\n");
}

export function render() {
  const src = readFileSync(path.join(root, "src", "shortcuts", "keymap.ts"), "utf8");
  const labels = JSON.parse(readFileSync(path.join(root, "src", "i18n", "pt-BR.json"), "utf8"));
  return buildTable(src, labels);
}

/** README com a tabela atual entre os marcadores. */
export function updatedReadme(readme, table) {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error("marcadores da tabela de atalhos ausentes no README");
  return `${readme.slice(0, a + BEGIN.length)}\n${table}\n${readme.slice(b)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const table = render();
  const readmePath = path.join(root, "README.md");
  const mode = process.argv[2];
  if (!mode) console.log(table);
  else {
    const readme = readFileSync(readmePath, "utf8");
    const next = updatedReadme(readme, table);
    if (mode === "--write") writeFileSync(readmePath, next);
    else if (mode === "--check" && next !== readme) {
      console.error("README desatualizado: rode node scripts/shortcuts-table.mjs --write");
      process.exit(1);
    }
  }
}
