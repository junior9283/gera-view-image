// Ir › Voltar / Avançar (Lote 8): histórico das visitas, como o do Pré-Visualização. Cada troca de
// documento ativo (ou de página) vira uma entrada; Voltar/Avançar andam por elas sem gravar nada.
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { getPrefs } from "../store/prefs";
import { notElsewhere } from "../tabs/open";
import { useUi } from "../store/ui";
import { activate, closeDocs } from "./actions";

interface Visit {
  id: DocId;
  /** Para achar o mesmo arquivo reaberto com outro id (navegação pela pasta). */
  path: string;
  page: number | null;
}

let past: Visit[] = [];
let future: Visit[] = [];
let last: Visit | null = null;
let traveling = false;
let scheduled = false;

function here(): Visit | null {
  const { docs, activeId } = useDocs.getState();
  const d = docs.find((x) => x.id === activeId);
  return d ? { id: d.id, path: d.path, page: useUi.getState().page } : null;
}

const same = (a: Visit | null, b: Visit | null) => a?.id === b?.id && a?.page === b?.page;

/** `activate` troca a página e o documento em dois passos: grava só o estado final, num microtask. */
function onChange(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (traveling) return;
    const now = here();
    if (same(now, last)) return;
    if (last) past.push(last);
    future = [];
    last = now;
  });
}

/** Um só documento aberto e Preferências › navegar pela pasta: Voltar reabre o arquivo anterior. */
const folderMode = (docs: DocInfo[]) => docs.length === 1 && getPrefs().browseFolder;

const openDoc = (docs: DocInfo[], v: Visit) => docs.find((d) => d.id === v.id) ?? docs.find((d) => d.path === v.path);

function reachable(v: Visit): boolean {
  const { docs } = useDocs.getState();
  return !!openDoc(docs, v) || (folderMode(docs) && docs[0].path !== v.path);
}

async function visit(v: Visit): Promise<void> {
  const { docs } = useDocs.getState();
  const d = openDoc(docs, v);
  if (d) return activate(d.id, v.page);
  const [opened] = await useDocs.getState().open([v.path]);
  if (!opened) return;
  activate(opened.id, v.page);
  await closeDocs([docs[0].id]);
}

/** Fechado aqui e aberto em outra janela: voltar a ele tiraria o foco desta. */
const elsewhere = async (v: Visit) =>
  !openDoc(useDocs.getState().docs, v) && !(await notElsewhere([v.path])).length;

async function travel(from: Visit[], to: Visit[]): Promise<void> {
  if (traveling) return;
  traveling = true;
  try {
    while (from.length) {
      const v = from.pop()!;
      if (!reachable(v) || (await elsewhere(v))) continue;
      if (last) to.push(last);
      await visit(v);
      break;
    }
  } finally {
    last = here();
    traveling = false;
  }
}

export const canBack = () => past.some(reachable);
export const canForward = () => future.some(reachable);
export const back = () => travel(past, future);
export const forward = () => travel(future, past);

/** Começa a gravar as visitas. Devolve a função que para e limpa o histórico. */
export function installHistory(): () => void {
  past = [];
  future = [];
  last = here();
  const offDocs = useDocs.subscribe(onChange);
  const offUi = useUi.subscribe(onChange);
  return () => {
    offDocs();
    offUi();
    past = [];
    future = [];
    last = null;
  };
}

/** Só para testes: esquece as visitas (o ouvinte continua ligado). */
export function resetHistoryForTests(): void {
  past = [];
  future = [];
  last = here();
}
