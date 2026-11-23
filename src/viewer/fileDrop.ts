import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { subscribe } from "../lib/events";
import { draggingOut } from "../sidebar/dragOut";
import { openFiles } from "../file/openFiles";

/** Abre os arquivos soltos na janela conforme Preferências › Abrir arquivos e mostra o primeiro. */
export async function openDropped(paths: string[]): Promise<void> {
  if (paths.length) await openFiles(paths);
}

/** Trata o drop no lugar de abrir (devolve `true`); `at` em px CSS da janela. */
export type DropTarget = (paths: string[], at: { x: number; y: number }) => boolean;
const targets = new Set<DropTarget>();

/** Lote 2: soltar uma imagem sobre a imagem aberta vira camada colada. Devolve o desregistro. */
export function registerDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => targets.delete(t);
}

/** Onde os arquivos arrastados estão (`null` = saíram); devolve `true` se mostra ali o lugar do drop. */
export type DropHover = (at: { x: number; y: number } | null) => boolean;
const hovers = new Set<DropHover>();

export function registerDropHover(h: DropHover): () => void {
  hovers.add(h);
  return () => hovers.delete(h);
}

/** Todos são avisados (quem deixou de ter o ponteiro limpa a marca). */
const hover: DropHover = (at) => [...hovers].map((h) => h(at)).some(Boolean);

/** Arrastar e soltar arquivos na janela (`onDragDropEvent`); devolve se há arquivos sobre a janela. */
export function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let files = false;
    const point = ({ x, y }: { x: number; y: number }) => {
      const k = window.devicePixelRatio || 1;
      return { x: x / k, y: y / k };
    };
    const leave = () => {
      files = false;
      hover(null);
      setOver(false);
    };
    return subscribe(
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        // Miniatura arrastada para fora e trazida de volta: não reabre o próprio arquivo.
        if (draggingOut() || payload.type === "leave") return leave();
        if (payload.type === "enter") files = payload.paths.length > 0;
        const at = point(payload.position);
        if (payload.type === "enter" || payload.type === "over") setOver(files && !hover(at));
        else if (payload.type === "drop") {
          leave();
          if (!payload.paths.length) return; // texto ou link: nada a abrir nem a colar
          if ([...targets].some((t) => t(payload.paths, at))) return;
          openDropped(payload.paths).catch((e) => console.error("falha ao abrir arquivos soltos:", e));
        }
      }),
    );
  }, []);
  return over;
}
