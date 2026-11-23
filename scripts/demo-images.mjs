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
/** PNG RGB; `extra` são pedaços `[tipo, dados]` gravados antes do IDAT (eXIf, iTXt). */
export function encodePng(w, h, rgb, extra = []) {
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
    ...extra.map(([type, data]) => chunk(type, data)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- TIFF (little-endian): EXIF e TIFF de várias páginas ----------
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;
const BYTE = 1;

function tagBytes(type, values) {
  if (type === ASCII) return Buffer.from(`${values}\0`, "utf8");
  if (type === UNDEFINED) return Buffer.from(values, "latin1");
  if (type === BYTE) return Buffer.from(values);
  const size = type === SHORT ? 2 : type === LONG ? 4 : 8;
  const b = Buffer.alloc(values.length * size);
  values.forEach((v, i) => {
    if (type === SHORT) b.writeUInt16LE(v, i * 2);
    else if (type === LONG) b.writeUInt32LE(v, i * 4);
    else {
      b.writeUInt32LE(v[0], i * 8);
      b.writeUInt32LE(v[1], i * 8 + 4);
    }
  });
  return b;
}

/**
 * Uma IFD que começa em `start`, com os valores longos logo depois dela. `entries`: `[tag, tipo,
 * valores]` em ordem crescente de tag. O tamanho não depende de `start` nem dos valores LONG.
 */
function ifd(entries, start, next = 0) {
  const head = Buffer.alloc(2 + entries.length * 12 + 4);
  head.writeUInt16LE(entries.length, 0);
  const data = [];
  let dataAt = start + head.length;
  entries.forEach(([tag, type, values], i) => {
    const bytes = tagBytes(type, values);
    const at = 2 + i * 12;
    head.writeUInt16LE(tag, at);
    head.writeUInt16LE(type, at + 2);
    const count = type === ASCII || type === UNDEFINED || type === BYTE ? bytes.length : values.length;
    head.writeUInt32LE(count, at + 4);
    if (bytes.length <= 4) bytes.copy(head, at + 8);
    else {
      head.writeUInt32LE(dataAt, at + 8);
      const padded = bytes.length % 2 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
      data.push(padded);
      dataAt += padded.length;
    }
  });
  head.writeUInt32LE(next, head.length - 4);
  return Buffer.concat([head, ...data]);
}

const TIFF_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
const dms = (deg, min, sec) => [
  [deg, 1],
  [min, 1],
  [sec, 1],
];

/** EXIF fictício: câmera de exemplo, exposição e GPS (Rio de Janeiro). */
export function demoExif() {
  const exifIfd = [
    [0x829a, RATIONAL, [[1, 250]]],
    [0x829d, RATIONAL, [[8, 1]]],
    [0x8827, SHORT, [100]],
    [0x9000, UNDEFINED, "0232"],
    [0x9003, ASCII, "2026:11:20 18:30:00"],
    [0x920a, RATIONAL, [[35, 1]]],
  ];
  const gpsIfd = [
    [0x0000, BYTE, [2, 3, 0, 0]],
    [0x0001, ASCII, "S"],
    [0x0002, RATIONAL, dms(22, 57, 7)],
    [0x0003, ASCII, "W"],
    [0x0004, RATIONAL, dms(43, 12, 38)],
    [0x0005, BYTE, [0]],
    [0x0006, RATIONAL, [[710, 1]]],
  ];
  const ifd0 = (exifAt, gpsAt) => [
    [0x010f, ASCII, "Exemplo"],
    [0x0110, ASCII, "Câmera de demonstração"],
    [0x011a, RATIONAL, [[72, 1]]],
    [0x011b, RATIONAL, [[72, 1]]],
    [0x0128, SHORT, [2]],
    [0x0131, ASCII, "demo-images.mjs"],
    [0x0132, ASCII, "2026:11:20 18:30:00"],
    [0x8769, LONG, [exifAt]],
    [0x8825, LONG, [gpsAt]],
  ];
  const exifAt = 8 + ifd(ifd0(0, 0), 8).length;
  const gpsAt = exifAt + ifd(exifIfd, exifAt).length;
  return Buffer.concat([TIFF_HEADER, ifd(ifd0(exifAt, gpsAt), 8), ifd(exifIfd, exifAt), ifd(gpsIfd, gpsAt)]);
}

/** Pacote XMP com título e palavras-chave (dc:subject). */
export function demoXmp(title, keywords) {
  const li = keywords.map((k) => `<rdf:li>${k}</rdf:li>`).join("");
  return (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>` +
    `<dc:subject><rdf:Bag>${li}</rdf:Bag></dc:subject>` +
    "</rdf:Description></rdf:RDF></x:xmpmeta>"
  );
}

/** Pedaço iTXt do PNG com o XMP (sem compressão). */
const xmpChunk = (xmp) => ["iTXt", Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(xmp, "utf8")])];

/** TIFF RGB de várias páginas, uma faixa Deflate por página. `pages`: `[{ w, h, rgb }]`. */
export function encodeTiff(pages) {
  const strips = pages.map((p) => deflateSync(p.rgb, { level: 9 }));
  const entries = (p, i, stripAt, stripLen) => [
    [256, LONG, [p.w]],
    [257, LONG, [p.h]],
    [258, SHORT, [8, 8, 8]],
    [259, SHORT, [8]],
    [262, SHORT, [2]],
    [273, LONG, [stripAt]],
    [277, SHORT, [3]],
    [278, LONG, [p.h]],
    [279, LONG, [stripLen]],
    [282, RATIONAL, [[72, 1]]],
    [283, RATIONAL, [[72, 1]]],
    [284, SHORT, [1]],
    [296, SHORT, [2]],
    [297, SHORT, [i, pages.length]],
  ];
  // Cada página: faixa (tamanho par) e depois a IFD; a 1ª IFD vem no cabeçalho.
  const padded = strips.map((s) => (s.length % 2 ? Buffer.concat([s, Buffer.alloc(1)]) : s));
  const stripAt = [];
  const ifdAt = [];
  let at = 8;
  pages.forEach((p, i) => {
    stripAt.push(at);
    ifdAt.push(at + padded[i].length);
    at = ifdAt[i] + ifd(entries(p, i, 0, 0), 0).length;
  });
  const header = Buffer.from(TIFF_HEADER);
  header.writeUInt32LE(ifdAt[0], 4);
  const body = pages.flatMap((p, i) => [
    padded[i],
    ifd(entries(p, i, stripAt[i], strips[i].length), ifdAt[i], ifdAt[i + 1] ?? 0),
  ]);
  return Buffer.concat([header, ...body]);
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

function pixels(fn) {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) px.set(fn(x, y), (y * W + x) * 3);
  return px;
}

/** Pôr do sol: céu em gradiente, sol, duas cadeias de montanhas e reflexo no lago. */
const porDoSol = () =>
  pixels((x, y) => {
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
  pixels((x, y) => {
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
  pixels((x, y) => {
    const v = Math.sin(x / 60) + Math.sin(y / 45) + Math.sin((x + y) / 90) + Math.sin(Math.hypot(x - 800, y - 530) / 40);
    return hsv(((v + 4) / 8 + x / W / 3) % 1, 0.65, 0.95);
  });

/** "Cartão-postal": moldura branca, céu, mar, sol, ilha com palmeira e selo no canto. */
const cartaoPostal = () =>
  pixels((x, y) => {
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
  pixels((x, y) => {
    const [cx, cy] = [800, 530];
    const a = Math.atan2(y - cy, x - cx);
    const r = Math.hypot(x - cx, y - cy);
    const star = 180 + 120 * Math.cos(5 * a);
    if (r < star) return mix([255, 210, 60], [240, 120, 30], r / 300);
    return [70, 175, 90];
  });

const png = (scene, extra) => () => encodePng(W, H, scene(), extra);
/** Metadados fictícios do pôr do sol, para o Inspetor (EXIF, GPS, título e palavras-chave). */
const sunsetMeta = () => [
  ["eXIf", demoExif()],
  xmpChunk(demoXmp("Pôr do sol sintético", ["pôr do sol", "montanhas", "lago", "exemplo"])),
];

export const IMAGES = {
  "01-por-do-sol.png": () => encodePng(W, H, porDoSol(), sunsetMeta()),
  "02-formas.png": png(formas),
  "03-padrao.png": png(padrao),
  "04-cartao-postal.png": png(cartaoPostal),
  "05-estrela-fundo-liso.png": png(fundoLiso),
  "06-tres-paginas.tif": () => encodeTiff([formas, cartaoPostal, fundoLiso].map((s) => ({ w: W, h: H, rgb: s() }))),
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, fn] of Object.entries(IMAGES)) {
    writeFileSync(path.join(outDir, name), fn());
    console.log(path.join(outDir, name));
  }
}
