import { useState } from "react";
import { AboutDialog } from "./AboutDialog";
import { OPEN_ABOUT_EVENT, OPEN_PREFERENCES_EVENT } from "./dialogs";
import { PreferencesDialog } from "./PreferencesDialog";
import { useWindowEvent } from "../lib/events";

type Open = "preferences" | "about" | null;

/** Mostra Preferências ou Sobre quando `openPreferences()` / `openAbout()` são chamados. */
export function DialogHost() {
  const [open, setOpen] = useState<Open>(null);

  useWindowEvent(OPEN_PREFERENCES_EVENT, () => setOpen("preferences"));
  useWindowEvent(OPEN_ABOUT_EVENT, () => setOpen("about"));
  useWindowEvent("keydown", (e) => e.key === "Escape" && setOpen(null));

  const close = () => setOpen(null);
  if (open === "preferences") return <PreferencesDialog onClose={close} />;
  if (open === "about") return <AboutDialog onClose={close} />;
  return null;
}
