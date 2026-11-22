import { notify } from "../chrome/notify";
import i18n from "../i18n";
import { takeMetaNotes } from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";

/**
 * Depois de gravar, mostra os avisos do Rust sobre título/descrição/autor/texto alternativo:
 * `xmpRebuilt` (o XMP foi refeito e perdeu o resto), `exifDropped` (o EXIF inteiro saiu),
 * `exifTooBig` (não cabe no JPEG) e `textNotSaved` (o formato não guarda o texto novo), com o nome do
 * documento. Um aviso que não chega nunca atrapalha a gravação.
 */
export async function reportMetaNotes(id: DocId): Promise<void> {
  try {
    const codes = await takeMetaNotes(id);
    const name = useDocs.getState().docs.find((d) => d.id === id)?.name;
    for (const code of codes) notify(`${name ? `${name}: ` : ""}${i18n.t(`file.metaNote.${code}`)}`);
  } catch {
    /* sem aviso */
  }
}
