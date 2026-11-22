import { describe, expect, it } from "vitest";
import { fieldLabel, fieldValue } from "./exifLabels";

describe("rótulos e valores dos metadados em português", () => {
  it.each([
    ["Make", "Fabricante"],
    ["Model", "Modelo"],
    ["DateTimeOriginal", "Data Original"],
    ["Is Progressive", "Progressivo"],
    ["Bits per Component", "Bits por Componente"],
    ["Interlaced", "Entrelaçado"],
    ["Caption", "Legenda"],
    ["Lens Model", "Modelo da Lente"],
    ["White Balance", "Balanço de Branco"],
  ])("%s é %s", (en, pt) => {
    expect(fieldLabel(en, "pt-BR")).toBe(pt);
    expect(fieldLabel(en, "en")).toBe(en);
  });

  it("rótulo desconhecido (ou que é nome de Object.prototype) fica no original", () => {
    for (const k of ["Compatible Brands X", "Tag(Exif, 37500)", "constructor", "__proto__", "toString", ""])
      expect(fieldLabel(k, "pt-BR")).toBe(k);
  });

  it.each([
    ["Is Progressive", "Yes", "Sim"],
    ["Interlaced", "No", "Não"],
    ["Interlace", "None", "Nenhum"],
    ["Color Type", "Grayscale", "Escala de cinza"],
    ["Orientation", "row 0 at top and column 0 at left", "Normal"],
    ["MeteringMode", "pattern", "Matricial"],
    ["ExposureProgram", "aperture priority", "Prioridade de abertura"],
    ["WhiteBalance", "auto white balance", "Automático"],
    ["ColorSpace", "uncalibrated", "Não calibrado"],
    ["ResolutionUnit", "inch", "Polegada"],
    ["Flash", "fired", "Disparou"],
    ["Flash", "not fired, suppressed", "Não disparou, desligado"],
    ["Flash", "fired, return light detected, auto, red-eye reduction", "Disparou, luz de retorno detectada, automático, redução de olhos vermelhos"],
    ["Loop Count", "Infinite", "Infinito"],
  ])("%s: %s é %s", (label, en, pt) => {
    expect(fieldValue(label, en, "pt-BR")).toBe(pt);
    expect(fieldValue(label, en, "en")).toBe(en);
  });

  it("texto livre nunca é traduzido, mesmo se coincidir com um valor", () => {
    for (const label of ["Title", "Caption", "Comment", "Author", "ImageDescription", "Artist"])
      for (const v of ["Yes", "No", "normal", "flash", "None"]) expect(fieldValue(label, v, "pt-BR")).toBe(v);
  });

  it("valor não previsto fica no original", () => {
    expect(fieldValue("Orientation", "[reserved orientation 9]", "pt-BR")).toBe("[reserved orientation 9]");
    expect(fieldValue("Flash", "fired, coisa nova", "pt-BR")).toBe("Disparou, coisa nova");
    expect(fieldValue("Flash", "constructor", "pt-BR")).toBe("constructor");
  });
});
