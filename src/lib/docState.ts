// Estado da interface que acompanha o documento quando ele muda de janela (Lote 12): desfazer,
// anotações, palavras-chave editadas... Quem guarda estado por documento registra aqui como
// levá-lo; quem também é fonte de "não salvo" diz a mesma chave em `registerDirtySource`.
import type { DocId } from "../ipc/types";

export interface DocCarrier {
  /** O que levar (`undefined` = nada); só dados que viram JSON. */
  dump: (id: DocId) => unknown;
  /** Recebe na janela nova, antes de o documento entrar no store. */
  load: (id: DocId, data: unknown) => void;
  /** Esquece na janela de origem, depois de entregue. */
  drop?: (id: DocId) => void;
  /** Trabalho em andamento que precisa terminar antes de levar. */
  settle?: (id: DocId) => Promise<unknown> | undefined;
}

export type DocStates = Record<DocId, Record<string, unknown>>;

const carriers = new Map<string, DocCarrier>();

/** Registra (ou substitui) uma parte do estado; devolve a função que a remove. */
export function registerDocState(key: string, carrier: DocCarrier): () => void {
  carriers.set(key, carrier);
  return () => {
    if (carriers.get(key) === carrier) carriers.delete(key);
  };
}

export const isCarried = (key: string): boolean => carriers.has(key);

export async function settleDocs(ids: DocId[]): Promise<void> {
  await Promise.allSettled(ids.flatMap((id) => [...carriers.values()].map((c) => c.settle?.(id))));
}

export function dumpDocs(ids: DocId[]): DocStates {
  const out: DocStates = {};
  for (const id of ids) {
    out[id] = {};
    for (const [key, c] of carriers) {
      const data = c.dump(id);
      if (data !== undefined) out[id][key] = data;
    }
  }
  return out;
}

/** Uma parte que falhe não impede as outras (o documento chega de qualquer jeito). */
export function loadDocs(states: DocStates): void {
  for (const [id, parts] of Object.entries(states)) {
    for (const [key, data] of Object.entries(parts)) {
      try {
        carriers.get(key)?.load(Number(id), data);
      } catch (e) {
        console.error(`estado "${key}" do documento ${id}:`, e);
      }
    }
  }
}

export function dropDocs(ids: DocId[]): void {
  for (const id of ids) for (const c of carriers.values()) c.drop?.(id);
}

// ---------- texto com compartilhamento ----------
// A pilha de desfazer guarda fotos das anotações que repetem os mesmos objetos (e os mesmos PNGs em
// base64): em JSON puro, cada foto levaria uma cópia. Aqui cada objeto e cada texto longo vai uma
// vez só, e a identidade entre eles volta como estava (o desfazer compara por identidade).

const LONG_TEXT = 64;

/** Nas posições de valor, um array é sempre a referência `[n]` para a tabela. */
type Ref = [number];
type Encoded = string | number | boolean | null | Ref;
type Node = string | { a: Encoded[] } | { o: Record<string, Encoded> };

export function pack(root: unknown): string {
  const table: Node[] = [];
  const seen = new Map<unknown, number>();
  const enc = (v: unknown): Encoded => {
    const text = typeof v === "string";
    if (text ? v.length <= LONG_TEXT : v === null || typeof v !== "object") return (v ?? null) as Encoded;
    let n = seen.get(v);
    if (n === undefined) {
      const entries = () => Object.entries(v as object).filter(([, x]) => x !== undefined);
      // Os filhos entram antes: as referências apontam sempre para trás.
      const node: Node = text ? v : Array.isArray(v) ? { a: v.map(enc) } : { o: Object.fromEntries(entries().map(([k, x]) => [k, enc(x)])) };
      n = table.push(node) - 1;
      seen.set(v, n);
    }
    return [n];
  };
  const ref = enc(root);
  return JSON.stringify({ table, root: ref });
}

export function unpack(text: string): unknown {
  const { table, root } = JSON.parse(text) as { table: Node[]; root: Encoded };
  const made: unknown[] = [];
  const dec = (v: Encoded): unknown => (Array.isArray(v) ? made[v[0]] : v);
  for (const n of table) {
    made.push(typeof n === "string" ? n : "a" in n ? n.a.map(dec) : Object.fromEntries(Object.entries(n.o).map(([k, x]) => [k, dec(x)])));
  }
  return dec(root);
}

/** Só para testes. */
export function resetDocStateForTests(): void {
  carriers.clear();
}
