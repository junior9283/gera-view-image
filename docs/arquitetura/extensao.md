# Pontos de extensão e lotes de paridade

O Lote 0 ("Fiação") registrou de uma vez tudo o que é compartilhado entre os Lotes 1 a 12 da
auditoria de paridade com o Pré-Visualização. Com isso, cada lote trabalha só nos próprios arquivos
e os lotes podem rodar em paralelo sem conflito de merge.

## O que já existe

| Peça | Onde | Como funciona |
|---|---|---|
| IDs de comando | `src/shortcuts/commands.ts` (`COMMAND_IDS`) | Todos os comandos dos lotes já existem. |
| Dono de cada comando | `src/shortcuts/planned.ts` (`PLANNED`) | Comando → número do lote. |
| Itens de menu | `src/chrome/menus.ts` | Na ordem e com os nomes do Pré-Visualização. |
| Atalhos | `src/shortcuts/keymap.ts` | Sem colisões (`planned.test.tsx`, `keymap.test.ts`). |
| Textos | `src/i18n/pt-BR.json`, `en.json` (`menu.*`) | Rótulos finais dos menus. |
| Preferências | `src/store/prefs.ts` | Campos e validadores de cada lote. |
| IPC | `src/ipc/commands.ts`, `src/ipc/types.ts` | Funções e tipos de cada lote. |
| Comandos Tauri | `src-tauri/src/commands/<módulo>.rs` + `lib.rs` | Stubs que devolvem `AppError::Unsupported` via `not_yet`. |
| Pontos de registro | um arquivo `register` por lote, importado no `main.tsx` | Vazios até o lote preencher. |
| Slots | `src/lib/slots.tsx` | `viewport-overlay`, `below-toolbar`, `title-accessory` e `above-content`. |

**Comando sem handler fica desabilitado.** O menu mostra o item em cinza, o submenu sem filho
habilitado também fica cinza e o atalho não faz nada (`isEnabled` é falso e `runCommand` devolve
`false`). Para ligar um comando, o lote chama `registerCommand(id, run, enabled?)` no seu arquivo de
registro e não edita nenhum dos arquivos da tabela acima.

## Como um lote se registra

```ts
// src/viewer/register.ts (Lote 8)
import { registerCommand } from "../shortcuts/commands";
import { registerSlot } from "../lib/slots";
import { Magnifier } from "./Magnifier";
import { toggleMagnifier } from "./magnifier";

registerCommand("tools.magnifier", toggleMagnifier);
registerSlot("viewport-overlay", "magnifier", Magnifier);
```

- Registros feitos no carregamento do módulo valem pela vida do app. Os que dependem de efeito
  (ouvintes, `listen`) devolvem a função que os desfaz, como `registerFileCommands`.
- O lote não muda `PLANNED`. A entrada só sai de lá se o comando for removido do app.
- Diálogo novo: o componente é montado por um slot (`below-toolbar` ou `above-content`, que ficam
  vazios sem registro), ou por um host próprio registrado num slot. `App.tsx` não é editado.
- Preferência nova que o Lote 0 não previu, chave de i18n que não seja de menu ou tipo IPC extra:
  só **acrescente linhas** (no fim do bloco do lote) nos arquivos compartilhados. O integrador
  resolve o merge. Rótulos de menu e atalhos já estão definidos e não devem mudar sem combinar.
- No Rust, o lote troca o corpo dos stubs do seu módulo, remove o `#![allow(unused_variables)]`
  quando não precisar mais dele e pode criar submódulos em `src-tauri/src/image/` ou `doc/`. Um
  comando Tauri novo precisa de mais uma linha em `lib.rs`: acrescente-a logo abaixo das do
  seu módulo.

## Arquivos de cada lote

"Exclusivo" quer dizer que só aquele lote edita o arquivo. Os comandos estão em `planned.ts`.

| Lote | Registro (importado no `main.tsx`) | Exclusivos | Comandos Tauri (stubs) | Prefs |
|---|---|---|---|---|
| 1 Cor | `src/color/register.ts` | `src/color/*`, `src-tauri/src/commands/color.rs`, `src-tauri/src/image/icc.rs` (novo) | `display_profile`, `list_profiles`, `assign_profile` | `colorManagement` |
| 2 Seleção e área de transferência | `src/select/register.tsx` | `src/select/*`, exceto `subject.ts`; `src-tauri/src/commands/paste.rs`; a linha `edit.copy` de `src/shortcuts/appCommands.ts` | `clipboard_image` | — |
| 3 Texto ao Vivo | `src/livetext/register.ts` | `src/livetext/*`, `src-tauri/src/commands/ocr.rs`, `src-tauri/src/image/ocr.rs` (novo) | `recognize_text`, `detect_codes`, `speak`, `stop_speaking` | `liveText` |
| 4 Remover Fundo | `src/select/subject.ts` | `src/select/subject.ts`, `src-tauri/src/commands/segment.rs`, `src-tauri/src/image/segment.rs` (novo) | `segment_subject` | — |
| 5 Finder | `src/finder/register.ts` (slot `title-accessory`) | `src/finder/*`, `src-tauri/src/commands/finder.rs`, `src-tauri/src/doc/finder.rs` e `versions.rs` (novos) | `file_tags`, `set_file_tags`, `set_locked`, `move_to_trash`, `list_versions`, `restore_version`, `save_as` | `versionsMaxMb` |
| 6 Barra, Compartilhar e Ajuda | `src/chrome/register.ts` | `src/chrome/Toolbar.tsx`, `MenuBar.tsx`, `chrome.css`, `CustomizeToolbar.tsx` (novo), `src-tauri/src/commands/share.rs` | `share_email`, `share_device`, `open_with_apps`, `open_with_app` | `toolbarHidden`, `toolbarItems`, `toolbarMode` |
| 7 Barra lateral | `src/sidebar/register.ts` | `src/sidebar/*`, `src/store/docs.ts` (`sortBy`), `src-tauri/src/commands/sidebar.rs` | `file_stats` | `sortBy` |
| 8 Visualizar extras | `src/viewer/register.ts` | `src/viewer/Magnifier.tsx`, `history.ts`, `register.ts` (novos) | — | `showImageBackground` |
| 9 Inspetor | `src/inspector/register.ts` | `src/inspector/*`, `src-tauri/src/commands/describe.rs`; `image/metadata.rs` depois do merge do agente `meta` | `edit_metadata` | — |
| 10 Marcação extra | `src/markup/register.ts` | `src/markup/*`, `src-tauri/src/commands/fonts.rs` | `system_fonts` | `recentColors` |
| 11 Exportar e Imprimir | `src/print/register.ts` | `src/print/*`, `src-tauri/src/commands/print.rs`, `src-tauri/src/image/pdf.rs` (novo); `ExportDialog.tsx`, `estimate.ts` e `encode.rs` depois do merge de `heic`/`meta` | `export_pdf`, `print_native` | — |
| 12 Janelas e Abas | `src/tabs/register.ts` (slot `above-content`) | `src/tabs/*`, `src-tauri/src/commands/window.rs`, `src-tauri/src/doc/store.rs` (estado por janela) | `new_window`, `list_windows`, `focus_window`, `merge_windows`, `scan_image` | `tabBar` |

### Observações por lote

- **Lote 2.** `edit.paste` já saiu de `src/file/register.ts` e está em `src/select/register.tsx`,
  fazendo o mesmo que Novo da Área de Transferência. O lote troca por colar como camada flutuante.
  `edit.copy` continua em `appCommands.ts`: para o Copiar sem seleção, o lote muda só aquela linha,
  porque um segundo registro no carregamento do módulo seria sobrescrito pelo `registerAppCommands`
  do App.
  Feito: Colar como camada (`src/select/paste.ts`), menu de contexto da imagem (`ContextMenu.tsx`,
  slot `viewport-overlay`) e soltar imagem sobre a imagem pelo gancho `registerDropTarget` de
  `src/viewer/fileDrop.ts`, que outros lotes também podem usar (um alvo que devolve `true` impede a
  abertura como documento).
- **Lote 5.** O popover do título entra pelo slot `title-accessory` (props `{ title }`), renderizado
  pela `TitleBar` ao lado do nome. Salvar Como recebe `ExportOptions` (`image/encode.rs`).
  Implementado: os diálogos (versões e confirmação do Lixo) entram pelo slot `above-content`;
  comandos extras `file_locked`, `version_preview` e `set_versions_limit`; `set_file_tags`
  devolve a lista gravada e `save_as` aceita `keywords`. O Salvar e o Exportar gravam por
  `doc::finder::overwrite` (guarda a versão anterior e mantém os xattr `user.*`).
- **Lote 6.** Alternar a barra de ferramentas é Ctrl+Shift+T, porque Ctrl+Alt+T abre o terminal no
  GNOME e no KDE. Os itens de Arquivo › Compartilhar são `file.shareEmail` e `file.shareDevice`.
  O campo Pesquisar do menu Ajuda é `help.search` (Ctrl+?) e fica no `MenuBar.tsx`.
- **Lote 7.** Ordenar Por grava `prefs.sortBy` ("manual" é a ordem do arraste).
- **Lote 8.** `file.closeAll` (Ctrl+Alt+W) fecha todos os documentos e passa pelo diálogo de não
  salvo (`confirmAndSave`). Mostrar Lupa usa a tecla `` ` ``. No ABNT2 ela é tecla morta, e o lote
  pode acrescentar um alias em `ALIASES`.
- **Lote 11.** `printDocs(ids?)` e `exportPdf(ids?)` (`src/print/print.ts`) aceitam uma lista de
  documentos, na ordem dada; sem ela, usam o ativo. A multisseleção da barra lateral chama essas duas.
  Documentos com anotações não achatadas entram como cópias, fechadas no fim. Em TIFF de várias
  páginas a anotação tem `page`, e `annotationLayers` gera um `Op::Composite { frame }` por página
  anotada; sem `frame`, o composite vale para todos os quadros (animação). No Rust,
  `print_preview` e `print_native` usam o mesmo cálculo de página (`image/print_layout.rs`), e as
  imagens são decodificadas e reduzidas fora da thread do GTK (`draw_page` com desenho adiado).
  Os formatos que só aparecem com Alt ficam em `ALT_FORMATS` (`estimate.ts`). A página interna
  `print.html` e os comandos `print_document`, `print_image`, `print_page` e `print_close` saíram.
- **Lote 12.** A barra de abas entra pelo slot `above-content`, que fica entre a barra de título e
  o corpo da janela e também é renderizado em tela cheia. `file.closeWindow` é Ctrl+Shift+W;
  `window.nextTab`/`prevTab` são Ctrl+Tab/Ctrl+Shift+Tab.

## Testes do Lote 0

- `src/shortcuts/planned.test.tsx` verifica três coisas. Todo comando planejado aparece uma vez nos
  menus, com rótulo nos dois idiomas, e todo `CommandId` está em algum menu. Nenhum atalho colide
  com outro nem com combinações do desktop. Um comando sem handler fica desabilitado no menu e
  habilita quando é registrado.
- `scripts/shortcuts-table.test.mjs` falha se a tabela de atalhos do README estiver desatualizada.
  Para regenerá-la, rode `node scripts/shortcuts-table.mjs --write`.
- `commands::tests::stubs_dos_lotes_devolvem_unsupported` (Rust) cobre o `not_yet`.
