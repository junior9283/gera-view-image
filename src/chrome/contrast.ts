// Contraste entre cores pela fórmula do WCAG 2 (luminância relativa).

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste (1 a 21) entre duas cores `#rrggbb`. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Branco, se der contraste AA sobre `bg`; senão preto (um dos dois sempre dá). */
export const readableOn = (bg: string): string => (HEX.test(bg) && contrast("#ffffff", bg) >= 4.5 ? "#ffffff" : "#000000");
