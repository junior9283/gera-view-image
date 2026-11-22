// O `plugin-store` é um só para o processo e cada janela guarda uma cópia em memória: sem avisar, a
// janela que grava por último apagaria o que a outra acabou de gravar (Lote 12).
import type { Store } from "@tauri-apps/plugin-store";

export interface SharedStore {
  set: (key: string, value: unknown) => Promise<void>;
  save: () => Promise<void>;
}

/**
 * Grava em `store` e chama `onForeign` quando OUTRA janela muda uma chave. O plugin avisa todas as
 * janelas na ordem das gravações, então com gravações daqui ainda sem eco o valor recebido é mais
 * velho que elas: só o último vale.
 */
export function shareStore(store: Store, onForeign: (key: string, value: unknown) => void): SharedStore {
  const pending = new Map<string, { echoes: string[]; crossed: boolean }>();
  const listening = Promise.resolve(
    store.onChange?.((key, value) => {
      const p = pending.get(key);
      if (!p) return onForeign(key, value);
      if (p.echoes[0] === JSON.stringify(value)) p.echoes.shift();
      else p.crossed = true;
      if (p.echoes.length) return;
      pending.delete(key);
      if (p.crossed) onForeign(key, value);
    }),
  ).then(Boolean, () => false);
  return {
    set: async (key, value) => {
      // Só há eco depois de o ouvinte estar ligado.
      if (await listening) {
        const p = pending.get(key) ?? { echoes: [], crossed: false };
        p.echoes.push(JSON.stringify(value));
        pending.set(key, p);
      }
      await store.set(key, value);
    },
    save: () => store.save(),
  };
}
