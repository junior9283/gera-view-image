// Propriedades editáveis de uma anotação no inspetor: posição e tamanho (px da imagem) e texto.
import { opacityOf, withOpacity } from "./colors";
import { DEFAULT_FONT, normBox, type Annotation, type Box } from "./model";

type BoxKind = "rect" | "oval" | "roundRect" | "star" | "polygon" | "text" | "highlight" | "signature" | "image";
const BOX_KINDS: readonly string[] = ["rect", "oval", "roundRect", "star", "polygon", "text", "highlight", "signature", "image"];

/** Anotação cuja caixa o inspetor edita (o balão tem cauda e fica de fora). */
export const hasEditableBox = (a: Annotation): a is Extract<Annotation, { kind: BoxKind }> => BOX_KINDS.includes(a.kind);

/** Caixa normalizada da anotação editável, ou `null`. */
export const editableBox = (a: Annotation): Box | null => (hasEditableBox(a) ? normBox(a.geom) : null);

/** Tamanho mínimo (px da imagem): uma caixa de 0 não pode ser selecionada de novo. */
export const MIN_SIZE = 1;

/** A anotação com a caixa trocada (só os campos dados); valor inválido (NaN, ≤ 0 em w/h) é ignorado. */
export function withBox(a: Annotation, patch: Partial<Box>): Annotation {
  if (!hasEditableBox(a)) return a;
  const b = normBox(a.geom);
  const ok = (v: number | undefined, min = -Infinity) => (v !== undefined && Number.isFinite(v) && v >= min ? v : undefined);
  const next: Box = {
    x: ok(patch.x) ?? b.x,
    y: ok(patch.y) ?? b.y,
    w: ok(patch.w, MIN_SIZE) ?? b.w,
    h: ok(patch.h, MIN_SIZE) ?? b.h,
  };
  return { ...a, geom: { ...a.geom, ...next } } as Annotation;
}

/** Assinatura, imagem e realce não têm cor própria: a opacidade não faz efeito neles. */
export const hasOpacity = (a: Annotation): boolean => !["signature", "image", "highlight"].includes(a.kind);

/** O texto só tem a cor da fonte; as formas têm borda e preenchimento. */
const colorOf = (a: Annotation): string => (a.kind === "text" ? (a.style.font ?? DEFAULT_FONT).color : a.style.stroke);

/** Opacidade (0 a 100) da anotação. */
export const opacityPct = (a: Annotation): number => opacityOf(colorOf(a));

/** A anotação com a opacidade `pct` na cor da fonte (texto) ou na borda e no preenchimento. */
export function withAnnotationOpacity(a: Annotation, pct: number): Annotation {
  if (!hasOpacity(a)) return a;
  const style =
    a.kind === "text"
      ? { ...a.style, font: { ...DEFAULT_FONT, ...a.style.font, color: withOpacity(colorOf(a), pct) } }
      : { ...a.style, stroke: withOpacity(a.style.stroke, pct), fill: a.style.fill && withOpacity(a.style.fill, pct) };
  return { ...a, style };
}
