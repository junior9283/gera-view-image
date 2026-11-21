import { useSyncExternalStore, type ComponentType } from "react";

/**
 * Pontos de extensão da interface. Uma tarefa registra componentes num slot
 * nomeado sem editar o arquivo que o hospeda (ex.: a Marcação registra a sua
 * camada no Viewport e a sua barra abaixo da barra de ferramentas).
 */
export type SlotName =
  | "viewport-overlay"
  | "below-toolbar"
  /** Ao lado do nome do arquivo na barra de título (Lote 5: popover do título). Props: `TitleProps`. */
  | "title-accessory"
  /** Entre a barra de título e o corpo da janela (Lote 12: barra de abas). Sem props. */
  | "above-content";

/** Props entregues aos componentes do slot `title-accessory`. */
export interface TitleProps {
  /** Nome mostrado no título (o do documento ativo, ou o do app). */
  title: string;
}

/** Props entregues aos componentes do slot `viewport-overlay`. */
export interface OverlayProps {
  /** Escala imagem→tela (px CSS por pixel da imagem). */
  scale: number;
  /** Deslocamento da imagem na área do Viewport, em px CSS. */
  panX: number;
  panY: number;
  /** Tamanho da imagem em pixels. */
  imageW: number;
  imageH: number;
}

type Entry = { key: string; Component: ComponentType<never> };

const slots = new Map<SlotName, Entry[]>();
const listeners = new Set<() => void>();
const EMPTY: Entry[] = [];

/**
 * Registra `Component` no slot com uma chave estável (registrar de novo com a
 * mesma chave substitui). Devolve a função que remove o registro.
 */
export function registerSlot<P>(name: SlotName, key: string, Component: ComponentType<P>): () => void {
  const list = (slots.get(name) ?? []).filter((e) => e.key !== key);
  slots.set(name, [...list, { key, Component: Component as ComponentType<never> }]);
  listeners.forEach((l) => l());
  return () => {
    slots.set(name, (slots.get(name) ?? []).filter((e) => e.key !== key));
    listeners.forEach((l) => l());
  };
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Renderiza, na ordem de registro, os componentes do slot com as mesmas props. */
export function Slot<P extends object>({ name, props }: { name: SlotName; props: P }) {
  const entries = useSyncExternalStore(subscribe, () => slots.get(name) ?? EMPTY);
  return (
    <>
      {entries.map(({ key, Component }) => {
        const C = Component as ComponentType<P>;
        return <C key={key} {...props} />;
      })}
    </>
  );
}

/** Só para testes. */
export function resetSlotsForTests(): void {
  slots.clear();
  listeners.forEach((l) => l());
}
