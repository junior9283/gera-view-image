// Ações do Texto ao Vivo usadas pelos menus, pelo menu de contexto e pelos atalhos.
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { WebKind } from "../ipc/types";
import { notify } from "../chrome/notify";
import { getPrefs, setPrefs } from "../store/prefs";
import { selectedOrAllText, useLiveText } from "./store";

export const hasText = () => !!useLiveText.getState().model?.words.length;

async function copy(text: string | undefined): Promise<void> {
  if (!text) return;
  await ipc.copyText(text);
  notify(i18n.t("livetext.copied"));
}

/** Copia a seleção (ou todo o texto) e avisa. */
export const copySelected = () => copy(selectedOrAllText());
export const copyAll = () => copy(useLiveText.getState().model?.text);

/** Traduzir/Pesquisar: abre o navegador só por escolha do usuário (o texto vai na URL). */
export const lookUp = (kind: Extract<WebKind, "translate" | "search">) =>
  ipc.openWeb(kind, selectedOrAllText(), i18n.language);

let speaking = false;
export const isSpeaking = () => speaking;

export async function startSpeaking(): Promise<void> {
  try {
    await ipc.speak(selectedOrAllText());
    speaking = true;
  } catch (e) {
    if ((e as { code?: string })?.code !== "unsupported") throw e;
    notify(i18n.t("livetext.speechMissing"));
  }
}

export async function stopSpeaking(): Promise<void> {
  speaking = false;
  await ipc.stopSpeaking();
}

export const toggleLiveText = () => setPrefs({ liveText: !getPrefs().liveText });
