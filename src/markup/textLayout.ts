// Quebra de linha do texto dentro das formas: a mesma no desenho, no achatamento e no editor.
import { cssFont } from "./fontCss";
import type { FontStyle } from "./model";

export const LINE_HEIGHT = 1.25;

type Measure = (s: string) => number;

/** Linhas de `text` que cabem em `width`; a palavra maior que a linha é partida (nunca menos de 1 caractere). */
export function wrapText(text: string, width: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line: string | null = null;
    for (const word of paragraph.split(" ")) {
      const longer: string = line === null ? word : `${line} ${word}`;
      if (measure(longer) <= width) {
        line = longer;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const char of word) {
        if (line && measure(line + char) > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line ?? "");
  }
  return lines;
}

/** Sem canvas (jsdom), a largura média de um caractere. */
export const roughWidth = (f: FontStyle): Measure => (s) => s.length * f.size * 0.62;

let measurer: CanvasRenderingContext2D | null | undefined;

/** Linhas do texto em px da imagem, para o editor (o desenho mede no próprio contexto). */
export function layoutLines(text: string, width: number, f: FontStyle): string[] {
  measurer ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const ctx = measurer;
  if (!ctx) return wrapText(text, width, roughWidth(f));
  ctx.font = cssFont(f);
  return wrapText(text, width, (s) => ctx.measureText(s).width);
}
