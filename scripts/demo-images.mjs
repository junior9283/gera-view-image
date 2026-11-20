#!/usr/bin/env node
// Gera as imagens de demonstração (e2e/demo/*.png) só com código: gradientes, formas e padrões.
// Nenhuma foto de terceiros. Uso: node scripts/demo-images.mjs [pasta]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ?? path.join(root, "e2e", "demo");

// ---------- PNG RGB 8 bits ----------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- desenho ----------
const W = 1600;
const H = 1067;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const hsv = (h, s, v) => {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
};

function render(fn) {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) px.set(fn(x, y), (y * W + x) * 3);
  return encodePng(W, H, px);
}

/** Pôr do sol: céu em gradiente, sol, duas cadeias de montanhas e reflexo no lago. */
const porDoSol = () =>
  render((x, y) => {
    const horizon = H * 0.62;
    const ridge1 = horizon - 120 - 70 * Math.sin(x / 140) - 40 * Math.sin(x / 47 + 1);
    const ridge2 = horizon - 40 - 50 * Math.sin(x / 90 + 2) - 20 * Math.sin(x / 31);
    if (y > horizon) {
      const t = (y - horizon) / (H - horizon);
      const wave = Math.sin(y / 3 + x / 60) * 0.06;
      return mix([250, 140, 90], [30, 40, 90], clamp01(t + wave));
    }
    if (y > ridge2) return mix([60, 40, 80], [40, 30, 60], (y - ridge2) / 80);
    if (y > ridge1) return mix([110, 70, 120], [80, 50, 100], (y - ridge1) / 160);
    const d = Math.hypot(x - W * 0.62, y - horizon + 170);
    if (d < 90) return [255, 236, 170];
    const sky = mix([40, 60, 140], [255, 150, 90], y / horizon);
    return d < 220 ? mix([255, 210, 140], sky, (d - 90) / 130) : sky;
  });

/** Formas geométricas coloridas sobre fundo claro. */
const formas = () =>
  render((x, y) => {
    const shapes = [
      () => Math.hypot(x - 380, y - 400) < 230 && [235, 80, 70],
      () => x > 700 && x < 1150 && y > 180 && y < 560 && [60, 130, 230],
      () => {
        const [cx, cy, r] = [1250, 760, 240];
        const inTri = y > cy - r && y < cy + r * 0.6 && Math.abs(x - cx) < ((y - (cy - r)) / (1.6 * r)) * r * 1.1;
        return inTri && [250, 190, 50];
      },
      () => Math.abs(x - 600) + Math.abs(y - 820) < 180 && [70, 180, 120],
      () => Math.hypot((x - 1350) / 1.6, y - 250) < 110 && [150, 90, 200],
    ];
    for (const s of shapes) {
      const c = s();
      if (c) return c;
    }
    const grid = x % 80 < 2 || y % 80 < 2;
    return grid ? [225, 228, 235] : [245, 246, 250];
  });

/** Padrão de ondas em arco-íris. */
const padrao = () =>
  render((x, y) => {
    const v = Math.sin(x / 60) + Math.sin(y / 45) + Math.sin((x + y) / 90) + Math.sin(Math.hypot(x - 800, y - 530) / 40);
    return hsv(((v + 4) / 8 + x / W / 3) % 1, 0.65, 0.95);
  });

/** "Cartão-postal": moldura branca, céu, mar, sol, ilha com palmeira e selo no canto. */
const cartaoPostal = () =>
  render((x, y) => {
    const m = 50;
    if (x < m || y < m || x >= W - m || y >= H - m) return [250, 248, 240];
    const stamp = x > W - m - 230 && x < W - m - 40 && y > m + 30 && y < m + 260;
    if (stamp) {
      const edge = x < W - m - 215 || x > W - m - 55 || y < m + 45 || y > m + 245;
      if (edge) return (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [250, 250, 250] : [210, 60, 60];
      return Math.hypot(x - (W - m - 135), y - (m + 145)) < 60 ? [255, 200, 60] : [40, 120, 190];
    }
    const sea = H * 0.6;
    const island = Math.hypot((x - 520) / 3.2, y - sea - 10) < 70 && y > sea - 30;
    if (island) return [230, 205, 150];
    const trunk = Math.abs(x - 520 - (sea - 30 - y) * 0.25) < 9 && y < sea - 25 && y > sea - 260;
    if (trunk) return [120, 80, 40];
    const leaves = Math.hypot(x - 580, y - (sea - 270)) < 90 && Math.abs(Math.sin(Math.atan2(y - (sea - 270), x - 580) * 3)) > 0.45;
    if (leaves) return [40, 140, 70];
    if (y > sea) {
      const t = (y - sea) / (H - sea);
      const glint = Math.abs(x - 1100) < 80 * (1 - t) && Math.sin(y / 2) > 0.4;
      return glint ? [255, 240, 200] : mix([40, 170, 200], [10, 60, 120], t);
    }
    const sun = Math.hypot(x - 1100, y - 330);
    if (sun < 80) return [255, 230, 120];
    return mix([120, 200, 250], [255, 220, 180], y / sea);
  });

/** Objeto sobre fundo liso (para o Alfa Instantâneo). */
const fundoLiso = () =>
  render((x, y) => {
    const [cx, cy] = [800, 530];
    const a = Math.atan2(y - cy, x - cx);
    const r = Math.hypot(x - cx, y - cy);
    const star = 180 + 120 * Math.cos(5 * a);
    if (r < star) return mix([255, 210, 60], [240, 120, 30], r / 300);
    return [70, 175, 90];
  });

const IMAGES = {
  "01-por-do-sol.png": porDoSol,
  "02-formas.png": formas,
  "03-padrao.png": padrao,
  "04-cartao-postal.png": cartaoPostal,
  "05-estrela-fundo-liso.png": fundoLiso,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, fn] of Object.entries(IMAGES)) {
    writeFileSync(path.join(outDir, name), fn());
    console.log(path.join(outDir, name));
  }
}
