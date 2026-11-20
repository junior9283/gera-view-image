import { useEffect, useState } from "react";
import { AboutDialog } from "./AboutDialog";
import { OPEN_ABOUT_EVENT, OPEN_PREFERENCES_EVENT } from "./dialogs";
import { PreferencesDialog } from "./PreferencesDialog";

type Open = "preferences" | "about" | null;

/** Mostra Preferências ou Sobre quando `openPreferences()` / `openAbout()` são chamados. */
export function DialogHost() {
  const [open, setOpen] = useState<Open>(null);

  useEffect(() => {
    const prefs = () => setOpen("preferences");
    const about = () => setOpen("about");
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener(OPEN_PREFERENCES_EVENT, prefs);
    window.addEventListener(OPEN_ABOUT_EVENT, about);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener(OPEN_PREFERENCES_EVENT, prefs);
      window.removeEventListener(OPEN_ABOUT_EVENT, about);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  const close = () => setOpen(null);
  if (open === "preferences") return <PreferencesDialog onClose={close} />;
  if (open === "about") return <AboutDialog onClose={close} />;
  return null;
}
