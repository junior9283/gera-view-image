// Texto ao Vivo: estado (texto reconhecido do documento ativo, seleção, Localizar) e o
// controlador que pede o OCR ao Rust quando o documento ativo, a revisão ou o quadro mudam.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../ipc/commands";
import { OCR_MODELS_PROGRESS_EVENT, type DetectedCode, type DocInfo, type LinkInfo, type OcrProgress } from "../ipc/types";
import { notifyError } from "../chrome/notify";
import { useDocs } from "../store/docs";
import { getPrefs, subscribePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { viewable } from "../viewer/actions";
import { buildModel, detectData, findMatches, rangeText, type DataItem, type Match, type TextModel } from "./text";

/**
 * - `off`: Texto ao Vivo desligado ou sem imagem.
 * - `needsModels`: falta baixar os modelos (só com pedido do usuário).
 * - `downloading` / `running` / `ready` / `error`.
 */
export type LiveStatus = "off" | "needsModels" | "downloading" | "running" | "ready" | "error";

interface LiveTextState {
  status: LiveStatus;
  /** `id:rev:frame` do resultado (ou do pedido em curso). */
  key: string | null;
  model: TextModel | null;
  data: DataItem[];
  codes: DetectedCode[];
  /** Destino normalizado (Rust) de cada link lido, pelo texto cru. */
  links: Record<string, LinkInfo>;
  /** Progresso do download (0 a 1). */
  progress: number;
  /** Botão Texto ao Vivo ligado: destaca todo o texto, links e QR codes. */
  highlight: boolean;
  /** Seleção: palavras de `a` a `b` (em qualquer ordem). */
  sel: { a: number; b: number } | null;
  find: { open: boolean; query: string; matches: Match[]; index: number };
}

const NO_FIND = { open: false, query: "", matches: [] as Match[], index: 0 };

const INITIAL: LiveTextState = {
  status: "off",
  key: null,
  model: null,
  data: [],
  codes: [],
  links: {},
  progress: 0,
  highlight: false,
  sel: null,
  find: NO_FIND,
};

export const useLiveText = create<LiveTextState>(() => INITIAL);

const set = (p: Partial<LiveTextState>) => useLiveText.setState(p);
const get = () => useLiveText.getState();

/** Documento e quadro que o Texto ao Vivo deve cobrir agora, ou `null`. */
function target(): { doc: DocInfo; frame: number; key: string } | null {
  if (!getPrefs().liveText) return null;
  const { docs, activeId } = useDocs.getState();
  const doc = docs.find((d) => d.id === activeId) ?? null;
  if (!viewable(doc)) return null;
  const frame = useUi.getState().page ?? 0;
  return { doc, frame, key: `${doc.id}:${doc.rev}:${frame}` };
}

/** Texto que abre como link (QR code): http(s), e-mail ou telefone. */
export const isLink = (s: string) => /^(https?:\/\/|mailto:|tel:)/i.test(s);

/** `null` = ainda não consultado. */
let modelsInstalled: boolean | null = null;

function clear(status: LiveStatus, key: string | null) {
  set({ status, key, model: null, data: [], codes: [], links: {}, sel: null, highlight: false, find: { ...get().find, matches: [], index: 0 } });
}

/** Alinha o estado ao documento ativo: pede o OCR, usa o cache do Rust ou cancela. */
export async function sync(): Promise<void> {
  const t = target();
  const s = get();
  if (!t) {
    if (s.status === "running") void ipc.cancelTextRecognition().catch(() => {});
    if (s.status !== "off" && s.status !== "downloading") clear("off", null);
    return;
  }
  if (t.key === s.key && s.status !== "off" && s.status !== "error") return;
  if (s.status === "downloading") return;
  const sameDoc = s.key?.split(":")[0] === String(t.doc.id);
  if (modelsInstalled === null) modelsInstalled = (await ipc.ocrModels()).installed;
  if (target()?.key !== t.key) return;
  if (!modelsInstalled) return clear("needsModels", t.key);
  // Na mesma imagem (edição), o texto anterior fica visível até o novo chegar.
  if (sameDoc) set({ status: "running", key: t.key });
  else clear("running", t.key);
  try {
    const lines = await ipc.recognizeText(t.doc.id, t.frame);
    if (get().key !== t.key) return;
    const model = buildModel(lines);
    const data = detectData(model);
    set({ status: "ready", model, data, sel: null });
    refreshFind();
    // QR code é extra: se falhar, o texto reconhecido continua valendo.
    const codes = await ipc.detectCodes(t.doc.id, t.frame).catch((e) => (console.error(e), [] as DetectedCode[]));
    if (get().key !== t.key) return;
    set({ codes });
    const hrefs = [...data.filter((d) => d.kind === "link").map((d) => d.href), ...codes.map((c) => c.text).filter(isLink)];
    const infos = await Promise.allSettled(hrefs.map((h) => ipc.inspectLink(h)));
    if (get().key !== t.key) return;
    const links: Record<string, LinkInfo> = {};
    infos.forEach((r, i) => r.status === "fulfilled" && (links[hrefs[i]] = r.value));
    set({ links });
  } catch (e) {
    // Pedido obsoleto (cancelado ou de outra imagem): o mais novo cuida do estado.
    if (get().key !== t.key) return;
    console.error(e);
    set({ status: "error" });
  }
}

/** Baixa os modelos (pedido explícito do usuário) e reconhece a imagem ativa. */
export async function downloadModels(): Promise<void> {
  if (get().status === "downloading") return;
  set({ status: "downloading", progress: 0 });
  const unlisten = await listen<OcrProgress>(OCR_MODELS_PROGRESS_EVENT, (e) =>
    set({ progress: e.payload.total ? e.payload.done / e.payload.total : 0 }),
  ).catch(() => () => {});
  try {
    await ipc.downloadOcrModels();
    modelsInstalled = true;
    set({ status: "off", key: null });
  } catch (e) {
    set({ status: "needsModels" });
    notifyError(e);
  } finally {
    unlisten();
  }
  await sync();
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Edições seguidas (girar várias vezes) disparam um OCR só. */
const SYNC_DELAY_MS = 250;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void sync().catch(notifyError), SYNC_DELAY_MS);
}

/** Liga o controlador às mudanças de documento, quadro e preferência. Devolve o desligamento. */
export function startLiveText(): () => void {
  const offs = [
    useDocs.subscribe((s, p) => (s.activeId !== p.activeId || s.docs !== p.docs) && schedule()),
    useUi.subscribe((s, p) => s.page !== p.page && schedule()),
    subscribePrefs(schedule),
  ];
  schedule();
  return () => {
    clearTimeout(timer);
    offs.forEach((f) => f());
  };
}

// ---------- seleção e Localizar ----------

export const setSelection = (sel: LiveTextState["sel"]) => set({ sel });
export const toggleHighlight = () => set({ highlight: !get().highlight });

function refreshFind() {
  const { find, model } = get();
  if (!find.open) return;
  const matches = model ? findMatches(model, find.query) : [];
  set({ find: { ...find, matches, index: Math.min(find.index, Math.max(0, matches.length - 1)) } });
}

export function openFind(): void {
  set({ find: { ...get().find, open: true } });
  refreshFind();
}

export const closeFind = () => set({ find: NO_FIND });

export function setFindQuery(query: string): void {
  set({ find: { ...get().find, query, index: 0 } });
  refreshFind();
}

/** Próxima (`1`) ou anterior (`-1`) ocorrência, em laço. */
export function stepFind(dir: 1 | -1): void {
  const { find } = get();
  if (!find.matches.length) return;
  const n = find.matches.length;
  set({ find: { ...find, index: (find.index + dir + n) % n } });
}

/** Texto selecionado, ou todo o texto. */
export function selectedOrAllText(): string {
  const { model, sel } = get();
  if (!model) return "";
  return sel ? rangeText(model, sel.a, sel.b) : model.text;
}

/** Só para testes. */
export function resetLiveTextForTests(): void {
  clearTimeout(timer);
  modelsInstalled = null;
  useLiveText.setState(INITIAL);
}
