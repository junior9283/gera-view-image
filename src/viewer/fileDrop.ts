import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useDocs } from "../store/docs";
import { activate } from "./actions";

/** Abre os arquivos soltos na janela e ativa o primeiro. */
export async function openDropped(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const [first] = await useDocs.getState().open(paths);
  if (first) activate(first.id);
}

/** Arrastar e soltar arquivos na janela (`onDragDropEvent`); devolve se há arquivos sobre a janela. */
export function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter") setOver(payload.paths.length > 0);
        else if (payload.type === "leave") setOver(false);
        else if (payload.type === "drop") {
          setOver(false);
          openDropped(payload.paths).catch((e) => console.error("falha ao abrir arquivos soltos:", e));
        }
      })
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return over;
}
