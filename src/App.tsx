import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { TitleBar, WindowFrame } from "./chrome/TitleBar";
import { Viewport } from "./viewer/Viewport";
import { Slideshow } from "./viewer/Slideshow";
import { Sidebar } from "./sidebar/Sidebar";
import { ContactSheet } from "./sidebar/ContactSheet";
import { useViewerShortcuts } from "./viewer/shortcuts";
import { useFileDrop } from "./viewer/fileDrop";
import { UpdateHost } from "./updater/UpdateDialog";
import { DialogHost } from "./prefs/DialogHost";
import { initDocs, useDocs } from "./store/docs";
import { useUi } from "./store/ui";

/** Com mais de uma imagem aberta, a barra de miniaturas aparece uma vez (como no Preview). */
function useAutoSidebar() {
  const many = useDocs((s) => s.docs.length > 1);
  useEffect(() => {
    if (many && useUi.getState().sidebar === "hidden" && !autoShown) {
      autoShown = true;
      useUi.getState().setSidebar("thumbs");
    }
  }, [many]);
}
let autoShown = false;

export default function App() {
  const { t } = useTranslation();
  const title = useDocs((s) => s.docs.find((d) => d.id === s.activeId)?.name);
  const sidebar = useUi((s) => s.sidebar);
  const fullscreen = useUi((s) => s.fullscreen);
  const slideshow = useUi((s) => s.slideshow);
  const dropping = useFileDrop();
  useViewerShortcuts();
  useAutoSidebar();

  useEffect(() => {
    initDocs().catch((e) => console.error("falha ao abrir imagens:", e));
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-fullscreen", fullscreen);
  }, [fullscreen]);

  return (
    <WindowFrame>
      {!fullscreen && <TitleBar title={title ?? "Gera View Image"} />}
      <div className="app-body">
        {sidebar === "thumbs" && <Sidebar />}
        {sidebar === "contact" ? <ContactSheet /> : <Viewport />}
        {dropping && <div className="drop-overlay">{t("viewer.dropHere")}</div>}
      </div>
      {slideshow && <Slideshow />}
      <UpdateHost />
      <DialogHost />
    </WindowFrame>
  );
}
