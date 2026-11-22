import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { subscribe } from "../lib/events";
import { draggingOut } from "../sidebar/dragOut";
import { openHere } from "../tabs/open";
import { activate } from "./actions";

/** Abre os arquivos soltos na janela e ativa o primeiro. */
export async function openDropped(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const [first] = await openHere(paths);
  if (first) activate(first.id);
}

/** Trata o drop no lugar de abrir (devolve `true`); `at` em px CSS da janela. */
export type DropTarget = (paths: string[], at: { x: number; y: number }) => boolean;
const targets = new Set<DropTarget>();

/** Lote 2: soltar uma imagem sobre a imagem aberta vira camada colada. Devolve o desregistro. */
export function registerDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => targets.delete(t);
}

/** Arrastar e soltar arquivos na janela (`onDragDropEvent`); devolve se há arquivos sobre a janela. */
export function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    return subscribe(
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        // Miniatura arrastada para fora e trazida de volta: não reabre o próprio arquivo.
        if (draggingOut()) return setOver(false);
        if (payload.type === "enter") setOver(payload.paths.length > 0);
        else if (payload.type === "leave") setOver(false);
        else if (payload.type === "drop") {
          setOver(false);
          const k = window.devicePixelRatio || 1;
          const at = { x: payload.position.x / k, y: payload.position.y / k };
          if ([...targets].some((t) => t(payload.paths, at))) return;
          openDropped(payload.paths).catch((e) => console.error("falha ao abrir arquivos soltos:", e));
        }
      }),
    );
  }, []);
  return over;
}
