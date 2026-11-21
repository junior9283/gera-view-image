// Texto ao Vivo: o texto reconhecido como um texto único (palavras separadas por espaço, linhas
// por quebra), com a posição de cada palavra nele. Serve à seleção, ao Localizar e aos
// detectores de dados. Tudo aqui é puro (sem React nem IPC).
import type { Rect, TextLine } from "../ipc/types";

export interface FlatWord {
  text: string;
  bbox: Rect;
  line: number;
  /** Intervalo `[start, end)` da palavra em `TextModel.text`. */
  start: number;
  end: number;
}

export interface TextModel {
  text: string;
  words: FlatWord[];
  lines: TextLine[];
}

export function buildModel(lines: TextLine[]): TextModel {
  const words: FlatWord[] = [];
  let text = "";
  lines.forEach((l, line) => {
    if (line > 0) text += "\n";
    l.words.forEach((w, i) => {
      if (i > 0) text += " ";
      words.push({ text: w.text, bbox: w.bbox, line, start: text.length, end: text.length + w.text.length });
      text += w.text;
    });
  });
  return { text, words, lines };
}

export const allText = (lines: TextLine[]) => buildModel(lines).text;

/** Texto das palavras de `a` a `b` (inclusive, em qualquer ordem). */
export function rangeText(m: TextModel, a: number, b: number): string {
  const [i, j] = a <= b ? [a, b] : [b, a];
  if (!m.words[i] || !m.words[j]) return "";
  return m.text.slice(m.words[i].start, m.words[j].end);
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Palavra sob o ponto (px da imagem). Com `nearest`, sem acerto exato, a mais próxima na
 * horizontal da linha que contém `y` (para estender a seleção arrastando entre palavras).
 */
export function wordAt(m: TextModel, x: number, y: number, nearest = false): number | null {
  const hit = m.words.findIndex((w) => inside(w.bbox, x, y));
  if (hit >= 0 || !nearest) return hit >= 0 ? hit : null;
  const line = m.lines.findIndex((l) => y >= l.bbox.y && y <= l.bbox.y + l.bbox.h);
  if (line < 0) return null;
  let best: number | null = null;
  let dist = Infinity;
  m.words.forEach((w, i) => {
    if (w.line !== line) return;
    const d = Math.max(w.bbox.x - x, x - (w.bbox.x + w.bbox.w), 0);
    if (d < dist) [best, dist] = [i, d];
  });
  return best;
}

/** Minúsculas sem acentos, com o índice no texto original de cada caractere normalizado. */
function fold(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const n = s[i].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (const c of n) {
      text += c;
      at.push(i);
    }
  }
  return { text, at };
}

export interface Match {
  start: number;
  end: number;
  /** Palavras tocadas pelo trecho. */
  words: number[];
}

const wordsIn = (m: TextModel, start: number, end: number) =>
  m.words.flatMap((w, i) => (w.start < end && w.end > start ? [i] : []));

/** Ocorrências de `query` (sem diferenciar maiúsculas nem acentos; espaços equivalem a quebras). */
export function findMatches(m: TextModel, query: string): Match[] {
  const q = fold(query.trim().replace(/\s+/g, " ")).text;
  if (!q) return [];
  const hay = fold(m.text.replace(/\n/g, " "));
  const out: Match[] = [];
  for (let i = hay.text.indexOf(q); i >= 0; i = hay.text.indexOf(q, i + q.length)) {
    const start = hay.at[i];
    const end = hay.at[i + q.length - 1] + 1;
    out.push({ start, end, words: wordsIn(m, start, end) });
  }
  return out;
}

export type DataKind = "link" | "email" | "phone";

export interface DataItem extends Match {
  kind: DataKind;
  text: string;
  /** `https://`, `mailto:` ou `tel:`. */
  href: string;
}

const DETECTORS: [DataKind, RegExp, (s: string) => string][] = [
  ["link", /\b(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]]/gi, (s) => (/^www\./i.test(s) ? `https://${s}` : s)],
  ["email", /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/gu, (s) => `mailto:${s}`],
  [
    "phone",
    /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,3}\)\s?|\b\d{2,3}[\s.-])?\b\d{4,5}[\s.-]?\d{4}\b/g,
    (s) => `tel:${s.startsWith("+") ? "+" : ""}${s.replace(/\D/g, "")}`,
  ],
];

/** Links, e-mails e telefones no texto, na ordem do texto (um trecho só vale para o 1º detector). */
export function detectData(m: TextModel): DataItem[] {
  const out: DataItem[] = [];
  for (const [kind, re, href] of DETECTORS) {
    for (const r of m.text.matchAll(re)) {
      const start = r.index;
      const end = start + r[0].length;
      if (out.some((d) => d.start < end && d.end > start)) continue;
      out.push({ kind, text: r[0], href: href(r[0]), start, end, words: wordsIn(m, start, end) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
