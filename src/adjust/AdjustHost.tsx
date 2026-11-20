import { useState } from "react";
import { useDocs } from "../store/docs";
import { OPEN_ADJUST_COLOR_EVENT, OPEN_RESIZE_EVENT } from "./actions";
import { AdjustColorPanel } from "./AdjustColorPanel";
import { ResizeDialog } from "./ResizeDialog";
import { useWindowEvent } from "../lib/events";

type Open = "color" | "resize" | null;

/** Mostra Ajustar Cor ou Ajustar Tamanho para o documento ativo quando `openAdjustColor()`/`openResize()` são chamados. */
export function AdjustHost() {
  const [open, setOpen] = useState<Open>(null);
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);

  useWindowEvent(OPEN_ADJUST_COLOR_EVENT, () => setOpen("color"));
  useWindowEvent(OPEN_RESIZE_EVENT, () => setOpen("resize"));

  const close = () => setOpen(null);
  if (!doc || doc.error) return null;
  // `key` reinicia o estado do painel ao trocar de documento.
  if (open === "color") return <AdjustColorPanel key={doc.id} docId={doc.id} onClose={close} />;
  if (open === "resize") return <ResizeDialog key={doc.id} doc={doc} onClose={close} />;
  return null;
}
