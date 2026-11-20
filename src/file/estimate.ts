import { useEffect, useState } from "react";
import * as ipc from "../ipc/commands";
import type { DocId, ExportFormat, ExportOptions, SourceFormat } from "../ipc/types";

/** Espera depois da última mudança antes de pedir a estimativa ao Rust. */
export const ESTIMATE_DEBOUNCE_MS = 300;

/** Formatos com codificador no binário (HEIC e JPEG 2000 ficam ocultos: ver CHANGELOG). */
export const EXPORT_FORMATS: ExportFormat[] = ["jpeg", "png", "tiff", "webp", "avif", "exr", "bmp"];

export const EXTENSIONS: Record<ExportFormat, string> = {
  jpeg: "jpg", png: "png", tiff: "tiff", webp: "webp", avif: "avif", exr: "exr", bmp: "bmp", heic: "heic", jp2: "jp2",
};

/** Formato de exportação que corresponde ao do arquivo (para o tamanho resultante). */
export function exportFormatOf(f: SourceFormat): ExportFormat {
  return (EXPORT_FORMATS as string[]).includes(f) ? (f as ExportFormat) : "png";
}

export const defaultOptions = (format: ExportFormat): ExportOptions => ({
  format, quality: null, alpha: true, depth16: false, stripMetadata: false, resize: null,
});

/**
 * Tamanho estimado (bytes) pelo `estimate_size`, com debounce. `null` enquanto calcula ou se
 * `opts` é `null` (desligado). Erros viram `null` (a interface mostra o valor de reserva).
 */
export function useEstimate(id: DocId, opts: ExportOptions | null): number | null {
  const key = opts && JSON.stringify(opts);
  const [result, setResult] = useState<{ key: string; bytes: number } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    const timer = setTimeout(() => {
      ipc.estimateSize(id, JSON.parse(key) as ExportOptions).then(
        (bytes) => live && setResult({ key, bytes }),
        () => {},
      );
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, key]);
  return result && result.key === key ? result.bytes : null;
}

/** `1,2 MB`, `850 KB`. */
export function formatBytes(bytes: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(locale, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}
