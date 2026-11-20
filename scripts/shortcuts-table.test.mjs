import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTable, render, updatedReadme, BEGIN, END } from "./shortcuts-table.mjs";

const labels = {
  menu: {
    file: { title: "Arquivo", save: "Salvar", export: "Exportar…" },
    go: { title: "Ir", next: "Próximo" },
    tools: { title: "Ferramentas", annotate: "Anotar", annotateKinds: { arrow: "Seta" } },
  },
};
const src = `export const KEYMAP: Record<CommandId, string> = {
  "file.save": "Ctrl+S",
  "file.export": "",
  "go.next": "ArrowRight",
  "tools.annotate.arrow": "Ctrl+Shift+A",
};

export const ALIASES: Partial<Record<CommandId, string[]>> = {
  "go.next": ["PageDown"],
};
`;

test("monta linhas só dos comandos com atalho, com aliases e símbolos", () => {
  const t = buildTable(src, labels);
  assert.match(t, /\| Arquivo \| Salvar \| `Ctrl\+S` \|/);
  assert.doesNotMatch(t, /Exportar/);
  assert.match(t, /\| Ir \| Próximo \| `→` ou `PageDown` \|/);
  assert.match(t, /\| Ferramentas \| Anotar ▸ Seta \| `Ctrl\+Shift\+A` \|/);
});

test("substitui só o trecho entre os marcadores", () => {
  const readme = `# x\n${BEGIN}\nvelho\n${END}\nfim\n`;
  assert.equal(updatedReadme(readme, "novo"), `# x\n${BEGIN}\nnovo\n${END}\nfim\n`);
  assert.throws(() => updatedReadme("sem marcadores", "x"));
});

test("README está em dia com keymap.ts", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(updatedReadme(readme, render()), readme, "rode node scripts/shortcuts-table.mjs --write");
});
