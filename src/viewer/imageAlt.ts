// Alternativa textual da imagem para leitores de tela: o nome do arquivo e, se houver, o texto
// alternativo ou a descrição (do arquivo ou editados no Inspetor).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { hasTexts, seedTexts, useTexts } from "../inspector/textEdits";
import { metadata } from "../ipc/commands";
import type { DocInfo } from "../ipc/types";

/** Espera antes de ler os metadados: passar depressa pelas imagens não lê os de cada uma. */
const DELAY_MS = 600;

/** `undefined` sem imagem para descrever. */
export function useImageAlt(doc: DocInfo | null): string | undefined {
  const { t } = useTranslation();
  const ok = doc && !doc.error ? doc : null;
  const id = ok?.id;
  const texts = useTexts(id ?? -1);
  // Gravar e reverter esquecem o que foi lido.
  const known = id !== undefined && hasTexts(id);
  useEffect(() => {
    if (id === undefined || known) return;
    let live = true;
    const timer = setTimeout(() => {
      metadata(id).then((m) => live && seedTexts(id, m.texts)).catch(() => {}); // fica só o nome
    }, DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, known]);
  if (!ok) return undefined;
  const text = texts.altText.trim() || texts.description.trim();
  return text ? t("viewer.imageAlt", { name: ok.name, text }) : ok.name;
}
