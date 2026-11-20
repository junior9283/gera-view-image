/** Executa já na primeira chamada e, no fim da janela, com o último argumento recebido. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = -Infinity;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (a: A) => {
    last = Date.now();
    fn(...a);
  };
  const t = (...a: A) => {
    const wait = last + ms - Date.now();
    if (wait <= 0) return run(a);
    pending = a;
    timer ??= setTimeout(() => {
      timer = null;
      if (pending) run(pending);
      pending = null;
    }, wait);
  };
  t.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return t;
}
