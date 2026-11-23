// Instância única: arquivos abertos pelo gerenciador de arquivos (ou `gera-view-image arquivo`) com
// o app já aberto chegam a esta janela pelo Rust (`commands/instance.rs`), que já os filtrou e a
// trouxe para a frente. Abrem como os do Abrir… (`openFiles`: abas, mesma janela ou janelas
// separadas; o que já está aberto em outra janela traz aquela janela).
import { notifyError } from "../chrome/notify";
import * as ipc from "../ipc/commands";
import { OPEN_REQUEST_EVENT } from "../ipc/types";
import { subscribe } from "../lib/events";
import { listenHere } from "../lib/window";
import { openFiles } from "./openFiles";

/** Retira a fila desta janela e abre; um pedido por vez, na ordem em que chegaram. */
let queue: Promise<void> = Promise.resolve();
const drain = () => {
  queue = queue
    .then(async () => {
      const paths = await ipc.takeOpenRequests();
      if (paths.length) await openFiles(paths);
    })
    .catch(notifyError);
};

/** Ouve os pedidos e, já ouvindo, pega os que chegaram antes; devolve a função que para. */
export function registerOpenRequests(): () => void {
  const listening = listenHere(OPEN_REQUEST_EVENT, drain);
  listening.then(drain, drain);
  return subscribe(listening);
}
