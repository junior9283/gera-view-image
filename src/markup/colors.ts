// Cores da Marcação: opacidade embutida no próprio valor (#rrggbbaa), cores recentes e a
// leitura do conta-gotas.
//
// Espaço de cor: tudo aqui é cor de TELA (a mesma que a interface desenha). As anotações são
// desenhadas em cor de tela e o núcleo as leva ao perfil do documento ao compor (`png_from_display`),
// então a cor lida do pixel exibido (`renderView`, que já passou por `to_display`) volta à imagem
// igual ao que se viu. Nunca leia o conta-gotas de pixels do documento e grave como cor de tela.
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { MAX_RECENT_COLORS } from "../store/prefs";

/** Cores base dos painéis e menus da barra. */
export const PALETTE = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#000000", "#8e8e93", "#ffffff"];

export interface Rgba { r: number; g: number; b: number; a: number }

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const byte = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
const h2 = (n: number) => byte(n).toString(16).padStart(2, "0");

/** `#rrggbb` ou `#rrggbbaa`; qualquer outro texto (nome de cor, `rgb()`) dá `null`. */
export function parseColor(c: string): Rgba | null {
  const m = HEX.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) : 255 };
}

/** Sempre minúsculo; só escreve o alfa quando não é opaco. */
export function formatColor({ r, g, b, a }: Rgba): string {
  return `#${h2(r)}${h2(g)}${h2(b)}${a >= 255 ? "" : h2(a)}`;
}

/** Cor sem o alfa (`#rrggbb`), para o `<input type="color">`; cor ilegível vira `fallback`. */
export function opaque(c: string, fallback = "#000000"): string {
  const p = parseColor(c);
  return p ? formatColor({ ...p, a: 255 }) : fallback;
}

/** Opacidade de 0 a 100 (cor ilegível conta como opaca). */
export const opacityOf = (c: string): number => Math.round(((parseColor(c)?.a ?? 255) / 255) * 100);

/** A mesma cor com a opacidade `pct` (0 a 100). Cor ilegível só é aceita se `pct` for 100. */
export function withOpacity(c: string, pct: number): string {
  const p = parseColor(c);
  if (!p) return c;
  return formatColor({ ...p, a: byte((Math.min(100, Math.max(0, pct)) / 100) * 255) });
}

/** Põe a cor no começo das recentes, sem repetir e no máximo `MAX_RECENT_COLORS`. */
export function pushRecent(list: readonly string[], color: string): string[] {
  const p = parseColor(color);
  if (!p) return [...list];
  const c = formatColor(p);
  return [c, ...list.filter((x) => x.toLowerCase() !== c)].slice(0, MAX_RECENT_COLORS);
}

/** `#rrggbb` do pixel RGBA lido da tela, ou `null` se estiver transparente. */
export function pixelColor(data: ArrayLike<number>): string | null {
  return data.length >= 4 && data[3] > 0 ? formatColor({ r: data[0], g: data[1], b: data[2], a: 255 }) : null;
}

/** Cor do pixel (x, y) da imagem `id` como o usuário o vê (cor de tela). */
export async function sampleScreenColor(id: DocId, x: number, y: number, w: number, h: number): Promise<string | null> {
  const px = Math.min(w - 1, Math.max(0, Math.floor(x)));
  const py = Math.min(h - 1, Math.max(0, Math.floor(y)));
  const v = await ipc.renderView(id, 0, 1, 1, { x: px, y: py, w: 1, h: 1 });
  return pixelColor(v.data);
}
