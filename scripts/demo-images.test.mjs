// Imagens de demonstração: o TIFF tem as páginas inteiras e o pôr do sol leva EXIF (com GPS) e XMP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { demoExif, demoXmp, encodeTiff, IMAGES } from "./demo-images.mjs";

/** IFDs de um TIFF little-endian: `[{ tag: [tipo, contagem, valor/offset] }]`. */
function ifds(b) {
  const out = [];
  for (let at = b.readUInt32LE(4); at; at = b.readUInt32LE(at + 2 + b.readUInt16LE(at) * 12)) {
    const tags = {};
    for (let i = 0; i < b.readUInt16LE(at); i++) {
      const e = at + 2 + i * 12;
      tags[b.readUInt16LE(e)] = [b.readUInt16LE(e + 2), b.readUInt32LE(e + 4), b.readUInt32LE(e + 8)];
    }
    out.push(tags);
  }
  return out;
}

test("TIFF de várias páginas: uma IFD por página, faixa Deflate com a imagem inteira", () => {
  const rgb = (v) => Buffer.alloc(4 * 3 * 3, v);
  const tif = encodeTiff([
    { w: 4, h: 3, rgb: rgb(10) },
    { w: 4, h: 3, rgb: rgb(200) },
  ]);
  assert.equal(tif.subarray(0, 4).toString("latin1"), "II*\0");
  const pages = ifds(tif);
  assert.equal(pages.length, 2);
  pages.forEach((p, i) => {
    assert.equal(p[256][2], 4);
    assert.equal(p[257][2], 3);
    assert.equal(p[259][2], 8, "Deflate");
    const strip = tif.subarray(p[273][2], p[273][2] + p[279][2]);
    assert.deepEqual(inflateSync(strip), rgb(i ? 200 : 10));
    assert.equal(p[297][2], i | (2 << 16), "PageNumber");
  });
});

test("EXIF fictício com câmera, exposição e GPS", () => {
  const exif = demoExif();
  const [ifd0] = ifds(exif);
  assert.ok(ifd0[0x8769] && ifd0[0x8825], "ponteiros do EXIF e do GPS");
  assert.equal(exif.readUInt16LE(ifd0[0x8769][2]), 6, "seis tags no sub-IFD Exif");
  const gpsAt = ifd0[0x8825][2];
  assert.equal(exif.readUInt16LE(gpsAt), 7, "sete tags de GPS (com altitude)");
  assert.match(exif.toString("utf8"), /Câmera de demonstração/);
});

test("XMP com título e palavras-chave acentuadas", () => {
  const x = demoXmp("Pôr do sol", ["pôr do sol", "lago"]);
  assert.match(x, /<dc:subject><rdf:Bag><rdf:li>pôr do sol<\/rdf:li><rdf:li>lago<\/rdf:li><\/rdf:Bag>/);
  assert.match(x, /<rdf:li xml:lang="x-default">Pôr do sol<\/rdf:li>/);
});

test("o pôr do sol leva eXIf e iTXt antes do IDAT", () => {
  const png = IMAGES["01-por-do-sol.png"]();
  const at = (t) => png.indexOf(Buffer.from(t, "latin1"));
  assert.ok(at("eXIf") > 0 && at("iTXt") > 0);
  assert.ok(at("eXIf") < at("IDAT") && at("iTXt") < at("IDAT"));
});
