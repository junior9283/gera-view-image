// Nome de família de fonte → CSS (sem dependências, usado pelo desenho e pelo editor de texto).

/** Famílias genéricas do CSS: não levam aspas. */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

/**
 * Nome de família pronto para `font`/`font-family`. O nome vem de arquivo de fonte ou de um
 * documento salvo (não confiável): vai entre aspas, sem aspas, barras invertidas nem quebras
 * de linha, e nomes que começam com número ou têm espaços continuam válidos.
 */
export function cssFamily(name: string): string {
  const n = name.trim();
  if (GENERIC.has(n.toLowerCase())) return n.toLowerCase();
  // eslint-disable-next-line no-control-regex
  const clean = n.replace(/["'\\\u0000-\u001f\u007f]/g, "");
  return clean ? `"${clean}"` : "sans-serif";
}

/** Valor do `font` do canvas/CSS para a fonte (com `sans-serif` de reserva). */
export const cssFont = (f: { family: string; size: number; bold: boolean; italic: boolean }): string =>
  `${f.italic ? "italic " : ""}${f.bold ? "bold " : ""}${f.size}px ${cssFamily(f.family)}, sans-serif`;
