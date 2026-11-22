import { useState } from "react";
import { useWindowEvent } from "../lib/events";
import { useDocs } from "../store/docs";
import { viewable } from "../viewer/actions";
import { AssignProfileDialog } from "./AssignProfileDialog";

const OPEN_EVENT = "gvi:open-assign-profile";

export const openAssignProfile = () => window.dispatchEvent(new Event(OPEN_EVENT));

/** Monta Atribuir Perfil… para o documento ativo (slot `above-content`). */
export function AssignProfileHost() {
  const [open, setOpen] = useState(false);
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  useWindowEvent(OPEN_EVENT, () => setOpen(true));
  if (!open || !viewable(doc)) return null;
  return <AssignProfileDialog key={doc.id} doc={doc} onClose={() => setOpen(false)} />;
}
