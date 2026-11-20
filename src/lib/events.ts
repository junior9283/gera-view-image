import { useEffect, useRef } from "react";

/** Registro assíncrono de ouvinte (`listen`, `onResized`…): devolve a limpeza, que também
 *  cancela o ouvinte se ele só ficar pronto depois de desmontar. Falhas no registro são ignoradas. */
export function subscribe(register: Promise<() => void>): () => void {
  let alive = true;
  let unlisten: (() => void) | undefined;
  register.then((u) => (alive ? (unlisten = u) : u())).catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}

/** Ouve um evento da `window` enquanto montado; usa sempre a versão mais recente de `handler`. */
export function useWindowEvent<K extends string>(
  name: K,
  handler: (e: K extends keyof WindowEventMap ? WindowEventMap[K] : Event) => void,
) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const on = (e: Event) => ref.current(e as never);
    window.addEventListener(name, on);
    return () => window.removeEventListener(name, on);
  }, [name]);
}
