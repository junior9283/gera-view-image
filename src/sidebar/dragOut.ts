// Arrastar miniaturas para fora da janela (arquivo para o gerenciador, o navegador, outro app).
// O arraste começa interno (reordenação); quando o ponteiro sai da janela, o Rust inicia o
// arraste nativo do GTK (`start_drag`).
import { startDrag } from "../ipc/commands";
import type { DocId, DocInfo, DragSource } from "../ipc/types";

/** Depois do fim do arraste, o `drop` na própria janela ainda pode chegar (eventos separados). */
const SETTLE_MS = 500;

let active = 0;

/** Ponteiro na borda da janela ou fora dela. */
export const isOutside = (p: { clientX: number; clientY: number }, w: { innerWidth: number; innerHeight: number }) =>
  p.clientX <= 0 || p.clientY <= 0 || p.clientX >= w.innerWidth || p.clientY >= w.innerHeight;

/** O que arrastar: a seleção inteira se a miniatura pressionada faz parte dela; senão, só ela. */
export function dragItems(docs: DocInfo[], selected: ReadonlySet<DocId>, pressed: DocId): DocInfo[] {
  const all = selected.has(pressed) && selected.size > 1;
  return docs.filter((d) => !d.error && (all ? selected.has(d.id) : d.id === pressed));
}

/** Arquivo do disco quando ele representa o documento; senão, PNG temporário gerado pelo Rust. */
export const dragPlan = (docs: DocInfo[], unsaved: (d: DocInfo) => boolean): DragSource[] =>
  docs.map((d) => ({ id: d.id, export: !d.path || unsaved(d) }));

/** Há um arraste para fora em andamento (a janela não deve abrir os próprios arquivos). */
export const draggingOut = () => active > 0;

/** Começa o arraste nativo; resolve quando ele termina. */
export async function startDragOut(items: DragSource[]): Promise<void> {
  if (!items.length) return;
  active++;
  try {
    await startDrag(items);
  } finally {
    setTimeout(() => active--, SETTLE_MS);
  }
}
