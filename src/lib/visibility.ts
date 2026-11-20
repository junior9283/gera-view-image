/** Um único IntersectionObserver para todos os observados (mesma margem), em vez de um por miniatura. */
const callbacks = new Map<Element, (visible: boolean) => void>();
let io: IntersectionObserver | null = null;

function shared(): IntersectionObserver {
  io ??= new IntersectionObserver(
    (entries) => {
      // Vários registros do mesmo elemento no lote: vale o último.
      const last = new Map<Element, boolean>();
      for (const e of entries) last.set(e.target, e.isIntersecting);
      for (const [el, visible] of last) callbacks.get(el)?.(visible);
    },
    { rootMargin: "200px" },
  );
  return io;
}

/** Avisa quando `el` entra/sai da área visível (+200 px). Devolve a função que para de observar. */
export function observeVisible(el: Element, cb: (visible: boolean) => void): () => void {
  callbacks.set(el, cb);
  shared().observe(el);
  return () => {
    callbacks.delete(el);
    io?.unobserve(el);
    if (!callbacks.size) {
      io?.disconnect();
      io = null;
    }
  };
}
