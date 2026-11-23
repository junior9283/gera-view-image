// Contraste entre cores pela fórmula do WCAG 2 (luminância relativa).

/** [r, g, b] de 0 a 255 e alfa de 0 a 1. */
type Rgba = [number, number, number, number];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)` e a sintaxe com espaços `rgb(1 2 3 / 50%)`. */
const FUNC = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i;

/** Lê `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` e `rgba()`; `null` para o resto. */
function parse(color: string): Rgba | null {
  const s = color.trim();
  const hex = HEX.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b, a = 255] = (full.match(/../g) ?? []).map((h) => parseInt(h, 16));
    return [r, g, b, a / 255];
  }
  const m = FUNC.exec(s);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)));
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [r, g, b, Math.min(1, a)];
}

const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** `top` (talvez translúcida) composta sobre `bottom` (opaca), como `#rrggbb`. */
export function over(top: string, bottom: string): string {
  const [t, b] = [parse(top), parse(bottom)];
  if (!t || !b) throw new Error(`cor inválida: ${top} sobre ${bottom}`);
  return hex([0, 1, 2].map((i) => t[i] * t[3] + b[i] * (1 - t[3])));
}

function luminance(color: string): number {
  const c = parse(color);
  if (!c) throw new Error(`cor inválida: ${color}`);
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste (1 a 21) entre duas cores opacas (o alfa é ignorado; use `over` antes). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Branco, se der contraste AA sobre `bg`; senão preto (um dos dois sempre dá). */
export const readableOn = (bg: string): string => (parse(bg) && contrast("#ffffff", bg) >= 4.5 ? "#ffffff" : "#000000");
