import { useSyncExternalStore } from "react";
import type { Store } from "@tauri-apps/plugin-store";

export interface Prefs {
  background: "window" | "black" | "white" | "gray" | "custom";
  customBg: string;
  browseFolder: boolean;
  openBehavior: "fit" | "actual";
  slideshowSeconds: number;
  autoUpdate: boolean;
  lastUpdateCheck: string | null;
  skippedVersion: string | null;
  nativeDecorations: boolean;
  language: "system" | "pt-BR" | "en";
  /** Arquivos recentes, o mais novo primeiro (máx. 20). */
  recent: string[];
}

export const MAX_RECENT = 20;
const FILE = "prefs.json";

export const DEFAULT_PREFS: Prefs = {
  background: "window",
  customBg: "#808080",
  browseFolder: true,
  openBehavior: "fit",
  slideshowSeconds: 3,
  autoUpdate: true,
  lastUpdateCheck: null,
  skippedVersion: null,
  nativeDecorations: false,
  language: "system",
  recent: [],
};

const oneOf = <T extends string>(...vals: T[]) => (v: unknown): v is T => vals.includes(v as T);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Validador por chave: valor inválido é descartado e o padrão permanece. */
const VALID: { [K in keyof Prefs]: (v: unknown) => v is Prefs[K] } = {
  background: oneOf("window", "black", "white", "gray", "custom"),
  customBg: (v): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v),
  browseFolder: isBool,
  openBehavior: oneOf("fit", "actual"),
  slideshowSeconds: (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 60,
  autoUpdate: isBool,
  lastUpdateCheck: isStrOrNull,
  skippedVersion: isStrOrNull,
  nativeDecorations: isBool,
  language: oneOf("system", "pt-BR", "en"),
  recent: (v): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string"),
};

const KEYS = Object.keys(DEFAULT_PREFS) as (keyof Prefs)[];

/** Mescla valores brutos sobre os padrões, ignorando chaves desconhecidas e valores inválidos. */
export function sanitize(raw: Record<string, unknown>): Prefs {
  const out: Record<string, unknown> = { ...DEFAULT_PREFS };
  for (const k of KEYS) if (k in raw && VALID[k](raw[k])) out[k] = raw[k];
  out.recent = [...new Set(out.recent as string[])].slice(0, MAX_RECENT);
  return out as unknown as Prefs;
}

let state: Prefs = DEFAULT_PREFS;
let store: Store | null = null;
let loading: Promise<Prefs> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export const getPrefs = (): Prefs => state;

export function subscribePrefs(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}

/** Chaves antigas do `localStorage` (updater e decoração nativa): lidas uma vez e removidas. */
function legacyValues(): Partial<Record<keyof Prefs, unknown>> {
  try {
    const get = (k: string) => localStorage.getItem(k);
    const found: Partial<Record<keyof Prefs, unknown>> = {};
    if (get("update.auto") !== null) found.autoUpdate = get("update.auto") !== "false";
    if (get("update.lastCheck") !== null) found.lastUpdateCheck = get("update.lastCheck");
    if (get("update.skipped") !== null) found.skippedVersion = get("update.skipped");
    if (get("gvi.nativeDecorations") === "1") found.nativeDecorations = true;
    return found;
  } catch {
    return {};
  }
}

function clearLegacy() {
  try {
    for (const k of ["update.auto", "update.lastCheck", "update.skipped", "gvi.nativeDecorations"]) localStorage.removeItem(k);
  } catch {
    /* sem armazenamento */
  }
}

async function doLoad(): Promise<Prefs> {
  const raw: Record<string, unknown> = {};
  const migrated: Record<string, unknown> = {};
  try {
    // Import dinâmico: o plugin só é carregado quando as preferências são lidas.
    const { load } = await import("@tauri-apps/plugin-store");
    store = await load(FILE, { defaults: {}, autoSave: false });
    const s = store;
    await Promise.all(KEYS.map(async (k) => (raw[k] = await s.get(k))));
    for (const [k, v] of Object.entries(legacyValues())) {
      if (raw[k] === undefined || raw[k] === null) {
        raw[k] = v;
        migrated[k] = v;
      }
    }
    await Promise.all(Object.entries(migrated).map(([k, v]) => s.set(k, v)));
    if (Object.keys(migrated).length) await store.save();
    clearLegacy();
  } catch {
    // Sem store (ex.: fora do Tauri): segue em memória, e o localStorage continua intacto.
    store = null;
    return state;
  }
  state = sanitize(raw);
  emit();
  return state;
}

/** Carrega o `prefs.json` (uma vez) e migra as chaves antigas do `localStorage`. */
export function loadPrefs(): Promise<Prefs> {
  return (loading ??= doLoad());
}

let pendingSave: Promise<void> = Promise.resolve();

/** Atualiza na hora (memória) e grava no store em segundo plano. */
export function setPrefs(patch: Partial<Prefs>): void {
  const clean = sanitize({ ...state, ...patch });
  const changed = KEYS.filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(state[k]));
  if (!changed.length) return;
  state = clean;
  emit();
  const s = store;
  if (!s) return;
  pendingSave = pendingSave
    .then(async () => {
      await Promise.all(changed.map((k) => s.set(k, clean[k])));
      await s.save();
    })
    .catch(() => {});
}

/** Põe o arquivo no topo dos recentes, sem duplicatas e no máximo 20. */
export function addRecent(path: string): void {
  setPrefs({ recent: [path, ...state.recent.filter((p) => p !== path)].slice(0, MAX_RECENT) });
}

/** Só para testes. */
export function resetPrefsForTests(): void {
  state = DEFAULT_PREFS;
  store = null;
  loading = null;
  pendingSave = Promise.resolve();
  emit();
}
