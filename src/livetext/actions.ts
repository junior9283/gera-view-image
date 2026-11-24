// Ações do Texto ao Vivo usadas pelos menus, pelo menu de contexto e pelos atalhos.
import { create } from "zustand";
import i18n from "../i18n";
import * as ipc from "../ipc/commands";
import type { LinkInfo, WebKind } from "../ipc/types";
import { codeOf, notify } from "../chrome/notify";
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
    if (codeOf(e) !== "unsupported") throw e;
    notify(i18n.t("livetext.speechMissing"));
  }
}

export async function stopSpeaking(): Promise<void> {
  speaking = false;
  await ipc.stopSpeaking();
}

export const toggleLiveText = () => setPrefs({ liveText: !getPrefs().liveText });

/** Pedido aguardando confirmação no `LiveTextHost`. */
export type Pending = { kind: "image" } | { kind: "link"; info: LinkInfo };
export const useConfirm = create<{ pending: Pending | null }>(() => ({ pending: null }));

export const askImageSearch = () => useConfirm.setState({ pending: { kind: "image" } });

/**
 * Abre um link lido da imagem. O Rust reconstrói e valida o link (o frontend não é barreira) e
 * diz o host em ASCII. `mailto:`, `tel:` e hosts IDN (que podem imitar outro site) pedem
 * confirmação mostrando o destino; `http(s)` com host ASCII abre direto.
 */
export async function openLink(href: string): Promise<void> {
  const info = useLiveText.getState().links[href] ?? (await ipc.inspectLink(href));
  if (/^https?:\/\//i.test(info.href) && !info.idn) return ipc.openWeb("link", info.href, "");
  useConfirm.setState({ pending: { kind: "link", info } });
}

/** Texto do `title` de um link: o host normalizado (se já conhecido) e o destino completo. */
export function linkTitle(href: string): string {
  const info = useLiveText.getState().links[href];
  return info?.host ? `${info.host} — ${info.href}` : (info?.href ?? href);
}
