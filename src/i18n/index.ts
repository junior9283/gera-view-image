import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { ErrorCode } from "../ipc/types";
import { getPrefs, subscribePrefs, type Prefs } from "../store/prefs";
import en from "./en.json";
import ptBR from "./pt-BR.json";

export type Lang = "pt-BR" | "en";

/** Preferência `system` segue o idioma do sistema: português (qualquer variante) vira pt-BR, o resto en. */
export function resolveLanguage(pref: Prefs["language"], system: string): Lang {
  if (pref !== "system") return pref;
  return system.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

const current = () => resolveLanguage(getPrefs().language, navigator.language);

void i18n.use(initReactI18next).init({
  resources: { "pt-BR": { translation: ptBR }, en: { translation: en } },
  lng: current(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** Reaplica o idioma quando a preferência muda (ou depois de carregar o prefs.json). */
subscribePrefs(() => {
  const lng = current();
  if (i18n.language !== lng) void i18n.changeLanguage(lng);
});

/** Mensagem traduzida de um código de erro do núcleo (`DocInfo.error`, `AppError.code`).
 *  Com `"doc"`, a versão longa da tela de documento que não abriu (genérica se o código for desconhecido). */
export const errorMessage = (code: ErrorCode | string, variant?: "doc"): string =>
  variant === "doc"
    ? i18n.t(`errors.doc.${code}`, { defaultValue: i18n.t("errors.doc.generic") })
    : i18n.t(`errors.${code}`);

export default i18n;
