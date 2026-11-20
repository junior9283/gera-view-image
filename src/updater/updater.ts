import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  notes: string;
  date: string | null;
}

export const RELEASES_URL = "https://github.com/junior9283/gera-view-image/releases/tag/v";
const DAY_MS = 24 * 3600_000;
const KEY_LAST = "update.lastCheck";
const KEY_SKIPPED = "update.skipped";
const KEY_AUTO = "update.auto";

/** No máximo 1× a cada 24 h e só com a verificação automática ligada. */
export function shouldCheck(lastCheckIso: string | null, now: Date, auto: boolean): boolean {
  if (!auto) return false;
  if (!lastCheckIso) return true;
  const last = Date.parse(lastCheckIso);
  return Number.isNaN(last) || now.getTime() - last >= DAY_MS;
}

export function isSkipped(version: string, skipped: string | null): boolean {
  return skipped !== null && version === skipped;
}

// localStorage pode lançar (modo privado, dados bloqueados): tratamos como vazio.
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* preferência não persistida */
  }
};

export const skipVersion = (version: string) => write(KEY_SKIPPED, version);
export const isAutoCheckEnabled = () => read(KEY_AUTO) !== "false";
export const setAutoCheck = (on: boolean) => write(KEY_AUTO, String(on));

let pending: Update | null = null;

/** Consulta o latest.json. Manual ignora o intervalo e a versão pulada. */
export async function checkForUpdate({ manual }: { manual: boolean }): Promise<UpdateInfo | null> {
  const now = new Date();
  if (!manual && !shouldCheck(read(KEY_LAST), now, isAutoCheckEnabled())) return null;
  const update = await check();
  write(KEY_LAST, now.toISOString());
  if (!update || (!manual && isSkipped(update.version, read(KEY_SKIPPED)))) {
    pending = null;
    return null;
  }
  pending = update;
  return { version: update.version, notes: update.body ?? "", date: update.date ?? null };
}

/** Baixa e instala a versão encontrada por `checkForUpdate`; `onProgress` recebe 0..1 (ou null se o tamanho for desconhecido). Não reinicia: use `restartApp`. */
export async function installUpdate(onProgress: (fraction: number | null) => void): Promise<void> {
  if (!pending) throw new Error("Nenhuma atualização pendente");
  let total = 0;
  let received = 0;
  await pending.downloadAndInstall((e: DownloadEvent) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      received += e.data.chunkLength;
      onProgress(total > 0 ? Math.min(received / total, 1) : null);
    } else onProgress(1);
  });
}

export const restartApp = () => relaunch();
