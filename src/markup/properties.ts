// Propriedades editáveis de uma anotação no inspetor: posição e tamanho (px da imagem) e texto.
import { normBox, type Annotation, type Box } from "./model";

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

/** O texto de uma anotação de texto trocado; as outras ficam iguais. */
export const withText = (a: Annotation, text: string): Annotation =>
  a.kind === "text" ? { ...a, geom: { ...a.geom, text } } : a;
