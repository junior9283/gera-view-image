import { describe, expect, it } from "vitest";
import { formatBytes, formatCoord, mapUrl } from "./format";

describe("formatação do inspetor", () => {
  it("coordenadas em graus e minutos com hemisfério", () => {
    expect(formatCoord(48.858333, "lat")).toBe("48° 51.500′ N");
    expect(formatCoord(-122.419444, "lon")).toBe("122° 25.167′ W");
    expect(formatCoord(-23.5, "lat")).toBe("23° 30.000′ S");
  });
  it("URL do OpenStreetMap", () => {
    expect(mapUrl({ lat: 48.5, lon: -122.25, alt: null })).toBe(
      "https://www.openstreetmap.org/?mlat=48.5&mlon=-122.25",
    );
  });
  it("tamanho de arquivo", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5,0 MB");
  });
});
