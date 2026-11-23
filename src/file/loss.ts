// O que uma gravação vai deixar de fora, para dizer antes de gravar: páginas e anotações de outras
// páginas (formatos de uma página só) e metadados que o formato não guarda.
import { askDiscard } from "../finder/store";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { DocInfo, ExportOptions } from "../ipc/types";
import { hasPages, leavesOut } from "../markup/pages";

/**
 * Formatos em que o Salvar/Exportar grava as palavras-chave e os textos: IPTC (JPEG, TIFF) e/ou XMP
 * (JPEG, TIFF, PNG, WebP). AVIF e HEIC (o codificador só grava EXIF), BMP, JPEG 2000 e OpenEXR não.
 */
export const TEXT_FORMATS: ReadonlySet<string> = new Set(["jpeg", "tiff", "png", "webp", "psd"]);
const EXIF_FORMATS: ReadonlySet<string> = new Set([...TEXT_FORMATS, "avif", "heic"]);

type Target = Pick<ExportOptions, "format" | "stripMetadata" | "frame" | "allPages">;

const t = (k: string, o: Record<string, unknown> = {}) => i18n.t(`file.loss.${k}`, o);

/** Só a página `frame` vai para o arquivo: as anotações não achatadas das outras ficam de fora. */
export const annotationsLoss = (d: DocInfo, o: Target): string[] =>
  hasPages(d) && !o.allPages && leavesOut(d.id, o.frame ?? 0) ? [t("annotations")] : [];

/** Metadados do arquivo de `d` que o formato não guarda. Remover metadados é uma escolha, não uma perda. */
export async function metadataLoss(d: DocInfo, o: Target): Promise<string[]> {
  const [noExif, noText] = [!EXIF_FORMATS.has(o.format), !TEXT_FORMATS.has(o.format)];
  if (o.stripMetadata || (!noExif && !noText)) return [];
  try {
    const has = (await ipc.metadata(d.id))?.carried;
    return [...(noExif && has?.exif ? [t("exif")] : []), ...(noText && has?.text ? [t("text")] : [])];
  } catch {
    return []; // documento sem arquivo, ou que sumiu: a gravação segue o caminho de sempre
  }
}

/** Pergunta antes de gravar, se algo ficaria de fora. `false` = o usuário cancelou. */
export async function confirmLosses(d: DocInfo, o: Target): Promise<boolean> {
  const pages = hasPages(d) && !o.allPages ? [t("pages", { page: (o.frame ?? 0) + 1, total: d.frames })] : [];
  const all = [...pages, ...annotationsLoss(d, o), ...(await metadataLoss(d, o))];
  return !all.length || askDiscard(d.id, d.name, "file.loss.title", "file.loss.ok", all);
}
