// A barra de abas que aparece sozinha com várias imagens respeita quem a ocultou de propósito.
import { showMany } from "../file/openFiles";
import { getPrefs, setPrefs } from "../store/prefs";

/** Mostra ou oculta a barra de abas a pedido do usuário (menu ou Preferências). */
export const setTabBar = (on: boolean) => setPrefs({ tabBar: on, tabBarHidden: !on });

/** A janela passou a ter várias imagens: `showMany`, salvo a barra de abas que o usuário ocultou. */
export function autoShowMany(): void {
  const { openFilesIn, tabBarHidden } = getPrefs();
  if (openFilesIn !== "tabs" || !tabBarHidden) showMany();
}
