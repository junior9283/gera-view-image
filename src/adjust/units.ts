export type Unit = "px" | "%" | "cm" | "mm" | "in";
export const UNITS: Unit[] = ["px", "%", "cm", "mm", "in"];

export const RESIZE_PRESETS = [
  { w: 320, h: 240 },
  { w: 640, h: 480 },
  { w: 800, h: 600 },
  { w: 1024, h: 768 },
  { w: 1280, h: 1024 },
  { w: 1920, h: 1080 },
  { w: 3840, h: 2160 },
] as const;

/** Resolução presumida quando o arquivo não informa. */
export const DEFAULT_DPI = 72;

/** Milímetros por unidade física (uma polegada = 25,4 mm). */
const MM: Record<"in" | "cm" | "mm", number> = { in: 25.4, cm: 10, mm: 1 };

/** `base` é a dimensão original em pixels (só usada por `%`). */
export function toPixels(value: number, unit: Unit, dpi: number, base: number): number {
  if (unit === "px") return value;
  if (unit === "%") return (value / 100) * base;
  return ((value * MM[unit]) / 25.4) * dpi;
}

export function fromPixels(px: number, unit: Unit, dpi: number, base: number): number {
  if (unit === "px") return px;
  if (unit === "%") return base === 0 ? 0 : (px / base) * 100;
  return ((px / dpi) * 25.4) / MM[unit];
}

/** Mantém a razão da imagem original ao alterar uma das dimensões (mínimo 1). */
export function linkDims(
  orig: { w: number; h: number },
  changed: "w" | "h",
  valuePx: number,
): { w: number; h: number } {
  const v = Math.max(1, Math.round(valuePx));
  if (changed === "w") return { w: v, h: Math.max(1, Math.round((v * orig.h) / orig.w)) };
  return { w: Math.max(1, Math.round((v * orig.w) / orig.h)), h: v };
}
