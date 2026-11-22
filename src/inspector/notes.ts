import { notify } from "../chrome/notify";
import i18n from "../i18n";
import { takeMetaNotes } from "../ipc/commands";
import type { DocId } from "../ipc/types";

/**
 * Depois de gravar, mostra os avisos do Rust sobre título/descrição/autor/texto alternativo:
 * `xmpRebuilt` (o XMP foi refeito e perdeu o resto), `exifDropped` (o EXIF inteiro saiu) e
 * `textNotSaved` (o formato não guarda o texto novo). Um aviso que não chega nunca atrapalha a gravação.
 */
export async function reportMetaNotes(id: DocId): Promise<void> {
  try {
    for (const code of await takeMetaNotes(id)) notify(i18n.t(`file.metaNote.${code}`));
  } catch {
    /* sem aviso */
  }
}
