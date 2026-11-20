export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;

/** Aplica zoom mantendo o ponto (px, py) da tela fixo sobre a imagem. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** Ajusta a imagem (w x h) dentro do contêiner (cw x ch), centralizada, sem ampliar além de 1x. */
export function fitView(w: number, h: number, cw: number, ch: number): View {
  const scale = Math.min(1, cw / w, ch / h);
  return { scale, x: (cw - w * scale) / 2, y: (ch - h * scale) / 2 };
}
