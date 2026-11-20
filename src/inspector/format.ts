import type { Gps } from "../ipc/types";

/** Graus e minutos decimais com hemisfério: `48° 51.500′ N`. */
export function formatCoord(value: number, axis: "lat" | "lon"): string {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = (abs - deg) * 60;
  if (min.toFixed(3) === "60.000") {
    deg += 1;
    min = 0;
  }
  const hemi = axis === "lat" ? (value < 0 ? "S" : "N") : value < 0 ? "W" : "E";
  return `${deg}° ${min.toFixed(3)}′ ${hemi}`;
}

export const mapUrl = (g: Gps) => `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}`;

const decimal = (n: number) => n.toFixed(1).replace(".", ",");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${decimal(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${decimal(n / 1024 ** 2)} MB`;
  return `${decimal(n / 1024 ** 3)} GB`;
}

/** Data ISO do Rust no formato local; devolve o texto original se não for uma data válida. */
export function formatDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
}
