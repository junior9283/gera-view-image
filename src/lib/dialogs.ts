// Seletores de arquivo do sistema. Passam por aqui (e não direto pelo plugin) para o app saber que há
// um aberto: ele não é um diálogo da página, e enquanto isso nenhum documento muda de janela.
import * as native from "@tauri-apps/plugin-dialog";

let opened = 0;

async function count<T>(run: () => Promise<T>): Promise<T> {
  opened += 1;
  try {
    return await run();
  } finally {
    opened -= 1;
  }
}

export const nativeDialogOpen = () => opened > 0;

export const open: typeof native.open = (options) => count(() => native.open(options));
export const save: typeof native.save = (options) => count(() => native.save(options));
