import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { TitleBar, WindowFrame } from "./chrome/TitleBar";
import { Viewport } from "./viewer/Viewport";
import { Slideshow } from "./viewer/Slideshow";
import { Sidebar } from "./sidebar/Sidebar";
import { ContactSheet } from "./sidebar/ContactSheet";
import { MenuBar } from "./chrome/MenuBar";
import { Toolbar } from "./chrome/Toolbar";
import { ToastHost } from "./chrome/Toast";
import { ShortcutsDialog } from "./chrome/ShortcutsDialog";
import { Slot } from "./lib/slots";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { registerAppCommands } from "./shortcuts/appCommands";
import "./select/register";
import { useFileDrop } from "./viewer/fileDrop";
import { UpdateHost } from "./updater/UpdateDialog";
import { DialogHost } from "./prefs/DialogHost";
import { AdjustHost } from "./adjust/AdjustHost";
import { InspectorHost } from "./inspector/Inspector";
import { FileHost } from "./file/FileHost";
import { openIds, separateWindows } from "./file/openFiles";
import type { DocId } from "./ipc/types";
import { MAIN_WINDOW, windowLabel } from "./lib/window";
import { initDocs, useDocs } from "./store/docs";
import { autoShowMany } from "./tabs/autoShow";
import { TAB_PANEL_ID } from "./tabs/TabBar";
import { receiveDocs } from "./tabs/transfer";
import { installWindowEvents } from "./tabs/windowEvents";
import { useUi } from "./store/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { syncFullscreen } from "./viewer/actions";
import { subscribe } from "./lib/events";

/** Uma falha aqui não impede de abrir as imagens. */
const joinWindow = () =>
  installWindowEvents().then(receiveDocs).catch((e) => console.error("falha ao ligar a janela:", e));

/** Liga a janela e abre os arquivos da linha de comando (só a principal os tem). */
async function startUp(): Promise<void> {
  let adopted: DocId[] = [];
  await initDocs(async () => {
    await joinWindow();
    adopted = openIds();
  });
  if (windowLabel() === MAIN_WINDOW) await separateWindows(useDocs.getState().docs.filter((d) => !adopted.includes(d.id)));
}

let autoShown = false;

/** Com mais de uma imagem aberta, a barra de miniaturas (ou a de abas) aparece uma vez (como no Preview). */
function useAutoSidebar() {
  const many = useDocs((s) => s.docs.length > 1);
  useEffect(() => {
    if (many && !autoShown) {
      autoShown = true;
      autoShowMany();
    }
  }, [many]);
}

export default function App() {
  const { t } = useTranslation();
  const title = useDocs((s) => s.docs.find((d) => d.id === s.activeId)?.name);
  const sidebar = useUi((s) => s.sidebar);
  const fullscreen = useUi((s) => s.fullscreen);
  const slideshow = useUi((s) => s.slideshow);
  const dropping = useFileDrop();
  useEffect(registerAppCommands, []);
  useShortcuts();
  useAutoSidebar();

  useEffect(() => {
    startUp().catch((e) => console.error("falha ao abrir imagens:", e));
  }, []);

  // A tela cheia também muda por fora (gerenciador de janelas): o estado segue a janela real.
  useEffect(() => {
    const sync = () => void syncFullscreen().catch(() => {});
    return subscribe(getCurrentWindow().onResized(sync));
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-fullscreen", fullscreen);
  }, [fullscreen]);

  return (
    <WindowFrame>
      {!fullscreen && (
        <>
          <TitleBar title={title ?? "Gera View Image"} leading={<MenuBar />}>
            <Toolbar />
          </TitleBar>
          <Slot name="below-toolbar" props={{}} />
        </>
      )}
      <Slot name="above-content" props={{}} />
      <div id={TAB_PANEL_ID} className="app-body">
        {sidebar === "thumbs" && <Sidebar />}
        {sidebar === "contact" ? <ContactSheet /> : <Viewport />}
        {dropping && <div className="drop-overlay">{t("viewer.dropHere")}</div>}
      </div>
      {slideshow && <Slideshow />}
      <UpdateHost />
      <DialogHost />
      <AdjustHost />
      <InspectorHost />
      <FileHost />
      <ShortcutsDialog />
      <ToastHost />
    </WindowFrame>
  );
}
