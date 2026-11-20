# Gera View Image — Plano de Implementação

> **Para agentes executores:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar este plano tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** visualizador/editor de imagens para Linux com paridade às funções de imagem do Preview do macOS, distribuído em `.deb`/`.rpm`/`.AppImage` com atualização automática assinada a partir dos GitHub Releases.

**Arquitetura:** app Tauri 2. O Rust guarda o documento como *original + lista de operações* (não destrutivo) e entrega prévias RGBA em resolução de tela. O React desenha a prévia num canvas, com uma camada vetorial de anotações por cima. A exportação final compõe tudo no Rust. O CI (tauri-action) gera os 3 pacotes e o `latest.json` a cada tag `v*`.

**Tech Stack:** Tauri 2 (`@tauri-apps/cli` 2.12.x, `@tauri-apps/api` 2.12.x, `tauri-plugin-updater` 2.14.x, `-dialog`, `-fs`, `-process`, `-opener`, `-clipboard-manager`, `-store`), Rust stable (crates `image`, `libheif-rs`, `rawler`, `psd`, `resvg`, `kamadak-exif`, `fast_image_resize`, `rayon`, `lru`, `notify`, `zbus`), React 18 + TypeScript + Vite, Zustand, i18next, Vitest (`pool: 'vmThreads'`, jsdom), ESLint, WebdriverIO + `tauri-driver`.

**Spec:** `docs/superpowers/specs/2026-11-20-gera-view-image-design.md` (leia junto; este plano argumenta a partir dela).

## Restrições globais

- Nome: **Gera View Image**; pacote/binário `gera-view-image`; identifier `io.github.junior9283.geraviewimage`; repositório `junior9283/gera-view-image` (público, MIT).
- SemVer, começa em `0.1.0`; `1.0.0` só com paridade completa da §5 da spec. Única fonte: `npm run release <versão>`. CHANGELOG no padrão Keep a Changelog. Commits Conventional Commits, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Proibido usar assets da Apple (SF Symbols, fonte SF, nome "Preview", logo). Fonte da interface: Inter (empacotada, OFL).
- Nunca gravar o arquivo do usuário sem Salvar explícito. Ao fechar com alterações, perguntar.
- A chave privada de assinatura fica **só** em `~/.tauri/gera-view-image.key` e no secret `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Nunca no repositório nem no log.
- `git push` só nos marcos marcados como **[PUSH]** neste plano. Eles estão autorizados pelo pedido do usuário de criar o repositório público.
- Interface em pt-BR e inglês (i18next, idioma do sistema). Todo texto visível passa por `t()`.
- Meta de desempenho: janela com imagem JPEG de 24 MP em < 400 ms (SSD, build release).
- Atalhos: os do Preview com Cmd→Ctrl (lista em `src/shortcuts/keymap.ts`, Tarefa 6).
- Linux x86_64 apenas.

## Foco de revisão

1. **Imagens enormes** (PNG de 100 MP, RAW de 45 MP): devem abrir sem estourar a memória, mostrar a prévia reduzida, gerar miniaturas sob demanda e manter o cache ≤ 1 GB. Teste na Tarefa 4.
2. **Orientação EXIF** (foto de celular com `Orientation=6`): deve aparecer em pé e continuar em pé depois de girar e salvar, com orientação gravada = 1. Teste na Tarefa 4 e na Tarefa 11.
3. **Caminhos com espaço e acento** (`/mnt/ssd/Documentos/APP/GERA VIEW IMAGE/Ação 1.jpg`): abrir, navegar na pasta, salvar, renomear e exportar. Teste na Tarefa 4 e na Tarefa 11.
4. **Arquivo corrompido, truncado ou não suportado** entre outros válidos: deve mostrar o estado de erro só nele, enquanto os demais continuam navegáveis. Teste na Tarefa 4 e na Tarefa 5.
5. **Arquivo alterado ou apagado por fora** enquanto está aberto: avisar e oferecer recarregar. Salvar não deve recriar silenciosamente um arquivo movido. Teste na Tarefa 11.

---

## Mapa de arquivos

```
package.json, vite.config.ts, tsconfig.json, eslint.config.js, vitest.config.ts
scripts/release.mjs                 # sincroniza versão + CHANGELOG + tag
scripts/screenshots.mjs             # gera prints do README via WebdriverIO
CHANGELOG.md, README.md, LICENSE
assets/logo/logo.svg                # logo fonte
docs/screenshots/*.png
.github/workflows/ci.yml, release.yml
src-tauri/
  tauri.conf.json, Cargo.toml, capabilities/default.json, icons/*
  linux/gera-view-image.desktop.hbs # MimeType=...
  src/main.rs                       # chama platform::apply_webkit_workarounds() antes do builder
  src/lib.rs                        # builder, plugins, registro de comandos
  src/platform/webkit.rs
  src/theme/{mod.rs,layout.rs,detect.rs,watch.rs}
  src/image/{mod.rs,decode.rs,encode.rs,metadata.rs,ops.rs,color.rs,select.rs,thumb.rs}
  src/doc/{mod.rs,model.rs,store.rs,cache.rs}
  src/commands/{mod.rs,docs.rs,view.rs,edit.rs,file.rs,meta.rs,theme.rs,capture.rs}
  tests/fixtures/*                  # amostras de cada formato (geradas por tests/make_fixtures.rs)
src/
  main.tsx, app/App.tsx, app/layout.css, app/tokens.css
  ipc/commands.ts, ipc/types.ts     # wrappers tipados de TODOS os comandos
  store/{docs.ts,ui.ts,prefs.ts}
  chrome/{TitleBar.tsx,WindowButtons.tsx,buttonStyles/*.css,windowTheme.ts,MenuBar.tsx,menus.ts}
  viewer/{Viewport.tsx,zoom.ts,Slideshow.tsx}
  sidebar/{Sidebar.tsx,ContactSheet.tsx}
  select/{tools.ts,lasso.ts,SelectionLayer.tsx}
  markup/{model.ts,history.ts,render.ts,sketch.ts,MarkupBar.tsx,tools/*.ts,SignaturePanel.tsx}
  adjust/{AdjustColorPanel.tsx,ResizeDialog.tsx,units.ts}
  inspector/Inspector.tsx
  file/{ExportDialog.tsx,fileActions.ts,unsaved.ts}
  updater/{updater.ts,UpdateDialog.tsx}
  prefs/PreferencesDialog.tsx
  shortcuts/{keymap.ts,useShortcuts.ts}
  i18n/{index.ts,pt-BR.json,en.json}
e2e/ (wdio.conf.ts, specs/*.e2e.ts)
docs/testes/{guia.md,armadilhas.md,bugs.md}
```

## Contratos centrais (valem para todas as tarefas)

Tipos Rust em `src-tauri/src/doc/model.rs` (serde `camelCase`, espelhados em `src/ipc/types.ts`):

```rust
pub struct DocId(pub u32);
pub enum SourceFormat { Jpeg, Png, Gif, Bmp, Tiff, Webp, Heic, Avif, Ico, Svg, Psd, Tga, Raw }
pub struct DocInfo { pub id: DocId, pub path: String, pub name: String, pub format: SourceFormat,
  pub width: u32, pub height: u32, pub frames: u32, pub writable: bool, pub dirty: bool,
  pub can_undo: bool, pub can_redo: bool, pub rev: u64, pub error: Option<String> }
pub struct Rect { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }
pub enum ResizeFilter { Nearest, Bilinear, Lanczos3 }
pub struct ColorAdjust { pub exposure: f32, pub contrast: f32, pub highlights: f32, pub shadows: f32,
  pub saturation: f32, pub temperature: f32, pub tint: f32, pub sepia: f32, pub sharpness: f32,
  pub levels: Levels }               // todos neutros = 0.0; Levels { black: 0, gamma: 1.0, white: 255 }
pub enum Mask { Rect(Rect), Ellipse(Rect), Polygon(Vec<(f32,f32)>), Bitmap { w: u32, h: u32, rle: Vec<u32> } }
pub enum Op { Rotate { quarter_turns: i8 }, FlipH, FlipV, Crop(Rect),
  Resize { w: u32, h: u32, filter: ResizeFilter, dpi: Option<f32> }, Adjust(ColorAdjust),
  Erase(Mask), MakeTransparent(Mask), Composite { png: Vec<u8> } }   // Composite = anotações achatadas
```

Comandos Tauri (snake_case no Rust, wrappers camelCase em `src/ipc/commands.ts`):

| Comando | Assinatura | Tarefa |
|---|---|---|
| `open_documents` | `(paths: Vec<String>) -> Vec<DocInfo>` | 4 |
| `close_document` | `(id: DocId)` | 4 |
| `folder_images` | `(path: String) -> Vec<String>` (ordenado natural, só extensões suportadas) | 4 |
| `render_view` | `(id, frame: u32, max_w: u32, max_h: u32, region: Option<Rect>) -> ipc::Response` (bytes: `u32 LE w`, `u32 LE h`, RGBA) | 4 |
| `thumbnail` | `(id, frame, size: u32) -> ipc::Response` (mesmo formato) | 4 |
| `apply_op` / `undo` / `redo` | `(id, op?) -> DocInfo` | 4 |
| `preview_adjust` | `(id, adjust: ColorAdjust, max_w, max_h) -> ipc::Response` (não altera o doc) | 9 |
| `histogram` / `auto_levels` | `(id) -> Histogram { r,g,b,l: Vec<u32> /*256*/ }` / `-> ColorAdjust` | 9 |
| `instant_alpha` | `(id, x: u32, y: u32, tolerance: f32) -> Mask` | 7 |
| `snap_lasso` | `(id, points: Vec<(f32,f32)>) -> Vec<(f32,f32)>` | 7 |
| `copy_region` | `(id, mask: Option<Mask>)` (coloca PNG na área de transferência) | 7 |
| `metadata` | `(id) -> Metadata { general, exif, iptc, gps: Option<Gps>, keywords }` | 10 |
| `save` | `(id) -> SaveOutcome { Saved(DocInfo) \| NeedsExport }` | 11 |
| `export` | `(id, dest: String, opts: ExportOptions) -> ()` | 11 |
| `estimate_size` | `(id, opts) -> u64` | 11 |
| `revert` | `(id, to: RevertTarget { LastSaved \| Original }) -> DocInfo` | 11 |
| `rename` / `move_to` / `duplicate` | `(id, ...) -> DocInfo` | 11 |
| `new_from_clipboard` / `capture_screen` | `(mode?) -> DocInfo` | 11 |
| `window_theme` | `() -> WindowTheme`; evento `window-theme-changed` com o mesmo payload | 3 |

`ExportOptions { format: ExportFormat /*Jpeg|Png|Tiff|Heic|Webp|Avif|Jp2|Exr|Bmp*/, quality: Option<u8>, alpha: bool, depth16: bool, strip_metadata: bool, resize: Option<(u32,u32)> }`.

Erros: todos os comandos retornam `Result<_, AppError>`, serializado como `{ code: string, message: string }`. Os códigos são `not_found`, `unsupported`, `corrupt`, `io`, `permission`, `changed_on_disk`.

---

### Tarefa 0: Esqueleto + validação WebKitGTK na máquina do usuário (marco 0, bloqueante)

**Arquivos:** criar a raiz do projeto (Vite React-TS + `src-tauri`), `src-tauri/src/main.rs`, `src-tauri/src/platform/webkit.rs`, `src/viewer/Viewport.tsx` (versão mínima), `vitest.config.ts`, `eslint.config.js`, `docs/testes/guia.md`, `.gitignore` (incluir `*.key`, `target/`, `node_modules/`, `dist/`).

**Interfaces:**
- Produz: `pub fn apply_webkit_workarounds(env: &dyn Fn(&str) -> Option<String>, set: &mut dyn FnMut(&str, &str))`. Se `GVI_GPU_ACCEL` não for `1` e a variável ainda não estiver definida, define `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Se `GVI_SAFE_RENDER=1`, define também `WEBKIT_DISABLE_COMPOSITING_MODE=1`.
- Produz: o app abre o arquivo passado em `argv[1]` e o exibe ajustado à janela (provisório: leitura com `image` e envio pelo formato de `render_view`).

- [ ] **Passo 1:** `npm create tauri-app@latest` (React, TypeScript, npm), com identifier e productName das restrições globais. Instalar ESLint, Vitest e jsdom. Scripts: `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:rust` (`cargo test --manifest-path src-tauri/Cargo.toml`).
- [ ] **Passo 2: teste que falha** em `webkit.rs`:
  ```rust
  #[test] fn define_dmabuf_quando_ausente() { /* env vazio → set chamado com ("WEBKIT_DISABLE_DMABUF_RENDERER","1") */ }
  #[test] fn respeita_valor_existente() { /* WEBKIT_DISABLE_DMABUF_RENDERER=0 já definido → não sobrescreve */ }
  #[test] fn gpu_accel_desliga_contorno() { /* GVI_GPU_ACCEL=1 → nada definido */ }
  #[test] fn safe_render_desliga_compositing() { /* GVI_SAFE_RENDER=1 → também WEBKIT_DISABLE_COMPOSITING_MODE=1 */ }
  ```
- [ ] **Passo 3:** implementar e chamar em `main.rs` antes do `tauri::Builder`. Rodar `npm run test:rust` → PASS.
- [ ] **Passo 4:** viewport mínimo: canvas que recebe o buffer, `ImageData` e `drawImage`, com zoom por Ctrl+roda e pan por arraste.
- [ ] **Passo 5: validação manual (critério da spec §13.2).** Gerar `npm run tauri build -- --bundles appimage,rpm`. Abrir uma imagem de 24 MP na GPU integrada e com Nvidia (`prime-run` ou `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`). Conferir que não há tela branca nem pisca, e que zoom/pan ficam fluidos. Medir o tempo de abertura. Registrar o resultado em `docs/testes/guia.md`. **Se falhar com os dois contornos: parar e levar ao usuário a proposta de trocar para Electron.**
- [ ] **Passo 6:** `git init` já existe. Fazer commit `chore: esqueleto Tauri e contorno WebKitGTK`.

### Tarefa 1: Logo e ícones

**Arquivos:** `assets/logo/logo.svg`, `src-tauri/icons/*` (via `npm run tauri icon assets/logo/logo.svg`), `public/logo.svg`.

- [ ] **Passo 1:** desenhar o logo original em SVG 1024×1024: uma moldura de foto arredondada em perspectiva leve com montanha e sol estilizados e uma lupa sobreposta. Gradiente azul-turquesa → violeta e forma de *squircle*, legível em 16 px. Nada de traço que lembre o ícone do Preview (lupa sobre fotos empilhadas da Apple).
- [ ] **Passo 2:** gerar os ícones e conferir 16, 32, 128 e 512 px renderizados (`rsvg-convert` ou o próprio PNG gerado), em fundo claro e escuro.
- [ ] **Passo 3:** mostrar o logo ao usuário (Read do PNG de 512 px no chat) e pedir ok antes de seguir. Commit `feat: logo e ícones`.

### Tarefa 2: Pipeline de versão, release e atualização automática **[PUSH]**

**Arquivos:** `scripts/release.mjs`, `scripts/release.test.mjs`, `CHANGELOG.md`, `LICENSE`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src-tauri/tauri.conf.json` (bundle + updater), `src-tauri/linux/gera-view-image.desktop.hbs`, `src/updater/updater.ts`, `src/updater/UpdateDialog.tsx`, `src/updater/updater.test.ts`.

**Interfaces:**
- Produz: `release.mjs <versão>`. Valida SemVer maior que a atual, atualiza `package.json`, `src-tauri/tauri.conf.json` e `src-tauri/Cargo.toml` (+ `Cargo.lock`), move `## [Não lançado]` → `## [x.y.z] - AAAA-MM-DD` no CHANGELOG, faz commit `chore(release): vX.Y.Z` e cria a tag `vX.Y.Z`. Não faz push.
- Produz (TS): `shouldCheck(lastCheckIso: string | null, now: Date, auto: boolean): boolean` (verifica no máximo 1×/24 h e só com `auto`), `isSkipped(version: string, skipped: string | null): boolean`, `checkForUpdate(opts: { manual: boolean }): Promise<UpdateInfo | null>`, `UpdateInfo { version, notes, date }`.

- [ ] **Passo 1: testes que falham** (`node --test scripts/release.test.mjs`): `rejeita versão não SemVer`, `rejeita versão menor ou igual`, `sincroniza os três arquivos` (fixture temporária), `move seção Não lançado no CHANGELOG com data`.
- [ ] **Passo 2:** implementar `release.mjs` e rodar → PASS.
- [ ] **Passo 3:** `tauri.conf.json`: `bundle.targets: ["deb","rpm","appimage"]`, `bundle.createUpdaterArtifacts: true`, `plugins.updater.endpoints: ["https://github.com/junior9283/gera-view-image/releases/latest/download/latest.json"]`, `plugins.updater.pubkey` (gerada no passo 4). Em `bundle.linux.deb.depends` / `rpm.depends`: `libheif1`/`libheif` (formato exato do pacote em cada distro). `.desktop` com `MimeType=image/jpeg;image/png;image/gif;image/bmp;image/tiff;image/webp;image/heic;image/heif;image/avif;image/x-icon;image/svg+xml;image/vnd.adobe.photoshop;image/x-tga;image/x-adobe-dng;image/x-canon-cr2;image/x-canon-cr3;image/x-nikon-nef;image/x-sony-arw;image/x-olympus-orf;image/x-panasonic-rw2;` e `Categories=Graphics;Viewer;2DGraphics;RasterGraphics;`.
- [ ] **Passo 4:** `npm run tauri signer generate -- -w ~/.tauri/gera-view-image.key` (com senha gerada aleatoriamente e guardada em `~/.tauri/gera-view-image.pass`, `chmod 600`). Criar o repositório `gh repo create junior9283/gera-view-image --public --source . --description "Visualizador e editor de imagens para Linux inspirado no Pré-Visualização do macOS"`. Cadastrar os secrets **lendo dos arquivos via stdin** (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/gera-view-image.key`), sem ecoar nada.
- [ ] **Passo 5:** `ci.yml` (push/PR): jobs paralelos `lint+typecheck`, `vitest`, `cargo test` (ubuntu-22.04 com `libwebkit2gtk-4.1-dev libheif-dev libayatana-appindicator3-dev librsvg2-dev patchelf`). `release.yml` (tag `v*`): `tauri-apps/tauri-action@v0` em `ubuntu-22.04`, com `tagName: ${{ github.ref_name }}`, `releaseBody` = seção da versão extraída do CHANGELOG, `includeUpdaterJson: true` e os secrets de assinatura. Depois, job `smoke-packages`: instalar o `.deb` em `ubuntu:24.04` e o `.rpm` em `fedora:41` e rodar `gera-view-image --version` (Tarefa 4 adiciona a flag `--version` ao `main.rs`; até lá, `rpm -qi`/`dpkg -I`).
- [ ] **Passo 6: testes que falham** em `updater.test.ts`: `shouldCheck(null, agora, true) === true`, `shouldCheck(há 23h, agora, true) === false`, `shouldCheck(há 25h, agora, true) === true`, `shouldCheck(null, agora, false) === false`, `isSkipped('0.2.0','0.2.0') === true`. Implementar e rodar → PASS.
- [ ] **Passo 7:** `UpdateDialog`: notas da versão (markdown simples) e os botões **Instalar e Reiniciar** (`update.downloadAndInstall` com barra de progresso → `relaunch()` do plugin-process), **Depois** e **Pular esta versão**. Em erro de instalação (sem `pkexec`, senha cancelada), o diálogo mostra "Não foi possível instalar automaticamente" com o botão **Abrir página da versão** (`https://github.com/junior9283/gera-view-image/releases/tag/vX`). A verificação roda 5 s após abrir e também pelo menu Ajuda ▸ Verificar Atualizações….
- [ ] **Passo 8:** commit, `git push -u origin main`, `npm run release 0.1.0` e `git push --follow-tags`. Acompanhar o Actions até o release existir com `.deb`, `.rpm`, `.AppImage`, `.sig` e `latest.json` contendo as chaves `linux-x86_64`, `linux-x86_64-deb`, `linux-x86_64-rpm` e `linux-x86_64-appimage`, ou as que a action gerar (registrar quais).
- [ ] **Passo 9: teste de atualização ponta a ponta.** Instalar o `.rpm` 0.1.0 nesta máquina e publicar `0.1.1` (entrada no CHANGELOG "Teste do atualizador"). Abrir o app, conferir que o diálogo aparece, instalar, reiniciar e ver a versão 0.1.1 em Sobre. Repetir com o AppImage. Registrar em `docs/testes/guia.md`.

### Tarefa 3: Barra de título unificada e botões que seguem o tema do Linux

**Arquivos:** `src-tauri/src/theme/{layout.rs,detect.rs,watch.rs}`, `src-tauri/src/commands/theme.rs`, `src/chrome/{TitleBar.tsx,WindowButtons.tsx,windowTheme.ts,buttonStyles/breeze.css,adwaita.css,elementary.css,generic.css}`, `src/chrome/windowTheme.test.ts`.

**Interfaces:**
- Produz (Rust): `enum WinButton { Minimize, Maximize, Close }`; `struct ButtonLayout { left: Vec<WinButton>, right: Vec<WinButton> }`; `fn parse_kwin(left: &str, right: &str) -> ButtonLayout`; `fn parse_gnome(layout: &str) -> ButtonLayout`; `enum DecorationStyle { Breeze, Adwaita, Elementary, Generic }`; `struct WindowTheme { layout: ButtonLayout, style: DecorationStyle, dark: bool, accent: Option<String> /*#rrggbb*/, icons: Option<ButtonIcons { close, minimize, maximize, restore: String /*data URL SVG*/ }>, colors: Option<WmColors { active_bg, active_fg, inactive_bg, inactive_fg }> }`; `fn detect_window_theme(env: &DesktopEnv) -> WindowTheme`, em que `DesktopEnv` encapsula a leitura de `XDG_CURRENT_DESKTOP`, arquivos e gsettings, para ser falsificável nos testes.
- Produz: comando `window_theme` e evento `window-theme-changed`. `watch.rs` assina o `SettingChanged` do portal (`zbus`, `org.freedesktop.portal.Settings`) e usa `notify` em `~/.config/kwinrc` e `~/.config/kdeglobals`, com debounce de 200 ms.

- [ ] **Passo 1: testes que falham** (`layout.rs`):
  ```rust
  assert_eq!(parse_kwin("MS", "IAX"), ButtonLayout{ left: vec![], right: vec![Minimize, Maximize, Close] });
  assert_eq!(parse_kwin("XIA", "M"), ButtonLayout{ left: vec![Close, Minimize, Maximize], right: vec![] });
  assert_eq!(parse_gnome("icon:minimize,maximize,close"), ButtonLayout{ left: vec![], right: vec![Minimize, Maximize, Close] });
  assert_eq!(parse_gnome("close,minimize,maximize:"), ButtonLayout{ left: vec![Close, Minimize, Maximize], right: vec![] });
  assert_eq!(parse_gnome(":close"), ButtonLayout{ left: vec![], right: vec![Close] });
  ```
  Padrões quando a chave estiver ausente: KDE `ButtonsOnLeft="MS"` e `ButtonsOnRight="HIAX"`, GNOME `"appmenu:close"`.
- [ ] **Passo 2: testes que falham** (`detect.rs`, com `DesktopEnv` falso): KDE + `library=org.kde.breeze` → `Breeze`; GNOME + `gtk-theme 'Adwaita'`/`'Adwaita-dark'` → `Adwaita` (dark=true no segundo); Pantheon → `Elementary`; KDE com Aurorae `__aurorae__svg__Foo` → `Generic` com `icons` preenchido a partir do tema de ícones (`kdeglobals [Icons] Theme` ou gsettings `icon-theme`, resolvendo `window-close-symbolic.svg` e similares pelas pastas XDG, com fallback para `hicolor`/`Adwaita`); o `color-scheme` do portal `1` → `dark=true`.
- [ ] **Passo 3:** implementar e rodar `npm run test:rust` → PASS.
- [ ] **Passo 4:** `tauri.conf.json`: `decorations: false`, `transparent: true`. `TitleBar` com `data-tauri-drag-region`, duplo clique para maximizar/restaurar, botão direito com o menu da janela, bordas de 6 px com `startResizeDragging(direção)` e cantos arredondados (8 px) quando não maximizado. Fallback: se `prefs.nativeDecorations` estiver ligado ou se a criação transparente falhar, `setDecorations(true)` e a TitleBar esconde os botões.
- [ ] **Passo 5:** `WindowButtons` renderiza `layout.left` e `layout.right` nas extremidades, com a classe `style-<breeze|adwaita|elementary|generic>`, `data-dark` e as variáveis CSS do accent e das cores. Breeze: ícones finos, hover com círculo, fechar vermelho `#da4453` no hover. Adwaita: botões circulares cinza translúcidos. Elementary: fechar à esquerda, sem fundo. Generic: ícones do tema via `<img src=dataURL>` com `filter` pela cor do texto. Alterna maximizar/restaurar conforme `onResized`. O `dark` do `WindowTheme` também define `document.documentElement.dataset.theme` (`light`/`dark`), então a interface inteira segue o tema do sistema ao vivo.
- [ ] **Passo 6: testes que falham** em `windowTheme.test.ts` (Vitest + Testing Library): `renderiza botões na ordem do layout`, `esconde botão ausente`, `atualiza ao receber window-theme-changed` (mock de `listen`), `botão maximizar vira restaurar quando maximizado`. Implementar e rodar → PASS.
- [ ] **Passo 7: verificação ao vivo** nesta máquina: trocar no Plasma (Configurações ▸ Decorações de janela) a posição dos botões e o esquema claro/escuro, com o app aberto. Os botões devem mudar em ≤ 1 s. Registrar. Commit `feat: barra de título com botões do tema do sistema`.

### Tarefa 4: Núcleo de imagem no Rust (decodificar, documento, prévias, cache)

**Arquivos:** `src-tauri/src/image/{decode.rs,ops.rs,thumb.rs}`, `src-tauri/src/doc/{model.rs,store.rs,cache.rs}`, `src-tauri/src/commands/{docs.rs,view.rs,edit.rs}`, `src-tauri/tests/make_fixtures.rs`, `src-tauri/tests/core.rs`, `src/ipc/{commands.ts,types.ts}`, `src/store/docs.ts`.

**Interfaces:**
- Produz: os tipos e comandos marcados como "4" nos Contratos centrais. `fn decode(path: &Path) -> Result<Decoded, AppError>` com `Decoded { frames: Vec<RgbaImage>, delays_ms: Vec<u32>, format, icc: Option<Vec<u8>>, exif: Option<Vec<u8>>, dpi: Option<(f32,f32)> }` (orientação EXIF já aplicada). `fn apply(img: &RgbaImage, op: &Op) -> RgbaImage` em `ops.rs` (Rotate, Flip, Crop, Resize, Erase, MakeTransparent e Composite; Adjust fica com a Tarefa 9). `DocStore` com `Mutex<HashMap<DocId, Document>>`, em que `Document { info, source: Decoded, ops: Vec<Op>, redo: Vec<Op>, saved_len: usize }`, `dirty = ops.len() != saved_len`. `RenderCache` LRU por bytes (≤ 1 GB) com a chave `(DocId, ops.len(), frame)`. Também a flag `--version` em `main.rs`.
- Consome: `rawler` (RAW, revelação padrão), `libheif-rs`, `psd`, `resvg` (SVG rasterizado em 2048 px no maior lado), `image` (os demais).

- [ ] **Passo 1:** `make_fixtures.rs` gera em `tests/fixtures/`: `rgb.jpg` com EXIF `Orientation=6`, `alpha.png`, `anim.gif` com 3 quadros, `multi.tiff` com 2 páginas, `img.webp`, `img.avif`, `img.bmp`, `img.ico`, `img.tga`, `img.svg`, `truncado.jpg` (os primeiros 500 bytes), `texto.png` (arquivo de texto com extensão png) e a pasta `Ação com espaço/` com 3 imagens. HEIC, PSD e DNG: baixar uma amostra pequena de domínio público e registrar a origem em `fixtures/README.md`.
- [ ] **Passo 2: testes que falham** (`tests/core.rs`):
  - `decodifica_cada_formato`: dimensões esperadas para cada fixture.
  - `aplica_orientacao_exif`: `rgb.jpg` de 40×20 com `Orientation=6` → 20×40.
  - `truncado_retorna_corrupt` e `texto_png_retorna_unsupported_ou_corrupt`: nenhum dos dois pode dar panic.
  - `gif_tem_3_quadros_e_delays`.
  - `open_documents_mistura_valido_e_invalido`: retorna 2 `DocInfo`, um deles com `error`.
  - `folder_images_ordenacao_natural_e_acentos`: `["img2.png","img10.png"]` em ordem natural, funcionando dentro de `Ação com espaço/`.
  - `rotate_4_vezes_volta_ao_original`, `crop_dimensoes`, `resize_lanczos_dimensoes`.
  - `undo_redo`: depois de apply, apply e undo → `can_redo`, `ops.len()==1`, `dirty`. Depois de undo → `dirty == false`.
  - `render_view_reduz_para_caber`: imagem 8000×6000 com max 1600×1200 → buffer de 1600×1200 e cabeçalho correto.
  - `cache_respeita_limite`: limite falsificado de 10 MB, inserir 30 MB → total ≤ 10 MB.
  - `imagem_enorme_nao_aloca_copias`: PNG de 12000×9000 gerado no teste, render 1600 px; medir o pico com o contador de bytes do cache e afirmar ≤ 2× o tamanho original.
- [ ] **Passo 3:** implementar o núcleo, com `rayon` nas operações por pixel e `fast_image_resize` para redimensionar. Rodar → PASS.
- [ ] **Passo 4:** wrappers TS tipados em `ipc/commands.ts` (`renderView` devolve `{ width, height, data: Uint8ClampedArray }`) e o store `docs.ts` (`docs`, `activeId`, `open(paths)`, `setActive`, `applyOp`, `undo`, `redo`). Vitest: `decodeViewBuffer` lê o cabeçalho LE corretamente.
- [ ] **Passo 5:** medir a abertura de um JPEG de 24 MP no build release (< 400 ms) e registrar. Commit `feat: núcleo de imagem não destrutivo`.

> A partir daqui, as Tarefas 5, 7, 9 e 10 dependem só da 4 e podem rodar **em paralelo em worktrees** (`isolation: "worktree"`). Cada uma registra seus comandos em `commands/mod.rs`/`lib.rs` e itens de menu em `menus.ts`. Conflitos nesses dois arquivos se resolvem no merge (só acrescentam linhas). A 6 depende da 5. A 8 depende da 5 e da 7. A 11 depende da 8 e da 9. A 12 depende da 6.

### Tarefa 5: Visualizador, barra lateral, navegação, tela cheia e apresentação

**Arquivos:** `src/viewer/{Viewport.tsx,zoom.ts,zoom.test.ts,Slideshow.tsx}`, `src/sidebar/{Sidebar.tsx,ContactSheet.tsx}`, `src/app/App.tsx`, `src/store/ui.ts`.

**Interfaces:**
- Produz: `zoom.ts` com `fitScale(img: Size, view: Size): number` (nunca > 1 para "Ajustar" salvo `allowUpscale`), `zoomAt(state: ViewState, factor: number, anchor: Point): ViewState` (mantém o ponto sob o cursor), `clampPan(state, img, view): ViewState`, `ZOOM_STEPS = [0.05,0.1,0.25,0.33,0.5,0.67,0.75,1,1.25,1.5,2,3,4,6,8,12,16,32]` e `nextStep(scale, dir)`. `ViewState { scale, panX, panY, mode: 'fit' | 'actual' | 'free' }`. O `ui.ts` expõe `sidebar: 'hidden' | 'thumbs' | 'contact'`, `fullscreen` e `slideshow`.
- O Viewport pede `render_view` com o tamanho do viewport × `devicePixelRatio`. Acima de 100 % de zoom, pede `region` só da área visível. Na troca de `rev`, mostra o buffer antigo escalado até chegar o novo, sem piscar.

- [ ] **Passo 1: testes que falham** (`zoom.test.ts`): `fitScale({4000,3000},{800,600}) === 0.2`, `fitScale imagem menor não amplia`, `zoomAt mantém âncora` (o ponto da imagem sob a âncora é igual antes e depois, com tolerância de 1e-6), `nextStep(1,+1)===1.25`, `nextStep(32,+1)===32`, `clampPan centraliza imagem menor que a view`.
- [ ] **Passo 2:** implementar `zoom.ts` → PASS.
- [ ] **Passo 3:** Viewport com xadrez para transparência, fundo pela preferência, Ctrl+roda, pinça (`wheel` com `ctrlKey` do touchpad), arraste com espaço/mão e duplo clique alternando ajustar/100 %. Estado de erro para `DocInfo.error`, com ícone, mensagem traduzida pelo `code` e nome do arquivo.
- [ ] **Passo 4:** Sidebar com miniaturas sob demanda (IntersectionObserver → `thumbnail(id, frame, 128*dpr)`), páginas de TIFF/GIF e itens com erro com miniatura de erro. Reordenar por arraste. Arrastar uma miniatura para fora gera o arquivo via `startDrag` do Tauri quando disponível (senão, só reordena). ContactSheet com grade e controle de tamanho (64–320 px). Arrastar e soltar arquivos na janela (`onDragDropEvent`) abre os arquivos.
- [ ] **Passo 5:** navegação: ←/→ e PageUp/PageDown entre os abertos. Com só um aberto e `prefs.browseFolder`, `folder_images` e navegação na pasta (o documento anterior é fechado se não estiver sujo; se estiver, pergunta via `unsaved.ts`, ou mantém aberto até a Tarefa 11 ligar o diálogo). Home/End vão para o primeiro/último.
- [ ] **Passo 6:** tela cheia (F11 e Ctrl+Meta+F) via `getCurrentWindow().setFullscreen`. Apresentação (Ctrl+Shift+F) com fundo preto, transição *fade* de 300 ms, avanço automático (5 s, configurável), barra de controles que aparece ao mover o mouse (anterior, pausa, próxima, índice, sair) e Esc para sair. GIF animado toca na apresentação e no viewport.
- [ ] **Passo 7: E2E** (`e2e/specs/viewer.e2e.ts`, criado com `wdio.conf.ts` apontando para o binário release via `tauri-driver`): abrir 3 fixtures, incluindo `truncado.jpg`; → navega; o erro aparece só no item ruim; Ctrl+0 / Ctrl+9 mudam a escala exibida. Commit.

### Tarefa 6: Barra de menus, atalhos e barra de ferramentas do Preview

**Arquivos:** `src/chrome/{MenuBar.tsx,menus.ts}`, `src/shortcuts/{keymap.ts,useShortcuts.ts,keymap.test.ts}`, `src/chrome/Toolbar.tsx`.

**Interfaces:**
- Produz: `type CommandId = 'file.open' | 'file.save' | ...` (todos os ids da tabela abaixo); `registerCommand(id: CommandId, run: () => void, enabled?: () => boolean)`; `KEYMAP: Record<CommandId, string /* 'Ctrl+Shift+A' */>`; `matchShortcut(e: KeyboardEvent): CommandId | null`. Os menus de `menus.ts` são declarativos (`{ label: i18nKey, command, submenu? }`). Itens de tarefas futuras aparecem desabilitados até o comando ser registrado.
- Menus: **Arquivo** (Novo da Área de Transferência Ctrl+N, Abrir… Ctrl+O, Abrir Recentes, Fechar Ctrl+W, Salvar Ctrl+S, Duplicar Ctrl+Shift+S, Renomear…, Mover Para…, Reverter Para ▸, Exportar…, Exportar Selecionadas…, Capturar Tela ▸, Imprimir… Ctrl+P), **Editar** (Desfazer Ctrl+Z, Refazer Ctrl+Shift+Z, Recortar Ctrl+X, Copiar Ctrl+C, Colar Ctrl+V, Apagar Del, Selecionar Tudo Ctrl+A, Desmarcar Tudo Esc, Inverter Seleção Ctrl+Shift+I) — *a barra de Marcação usa **Ctrl+Shift+M** (no Preview é Cmd+Shift+A, mas Ctrl+Shift+A conflita com convenções do Linux); registrar no README*, **Visualizar** (Ocultar/Miniaturas/Folha de Contatos Ctrl+Alt+1/2/3, Tamanho Real Ctrl+0, Ajustar Ctrl+9, Ampliar Ctrl+=, Reduzir Ctrl+-, Ampliar Seleção Ctrl+*, Mostrar Barra de Marcação Ctrl+Shift+M, Apresentação Ctrl+Shift+F, Tela Cheia F11), **Ir** (Anterior ←, Próximo →, Primeiro Home, Último End), **Ferramentas** (Girar Esquerda Ctrl+L, Girar Direita Ctrl+R, Espelhar Horizontal, Espelhar Vertical, Recortar Ctrl+K, Ajustar Cor… Ctrl+Alt+C, Ajustar Tamanho…, Alfa Instantâneo, Mostrar Inspetor Ctrl+I, Anotar ▸), **Janela** (Minimizar Ctrl+M, Maximizar), **Ajuda** (Atalhos, Verificar Atualizações…, Sobre).
- Toolbar à direita da TitleBar: alternar barra lateral, zoom −/+, compartilhar (menu Exportar…/Copiar/Abrir com…), marcação, girar e inspetor. Ícones SVG próprios em `src/chrome/icons/`.

- [ ] **Passo 1: testes que falham** (`keymap.test.ts`): `matchShortcut(Ctrl+K) === 'tools.crop'`, `Ctrl+Shift+Z === 'edit.redo'`, `não há dois comandos com o mesmo atalho` (verifica todo o KEYMAP), `ignora atalhos quando o foco está num input de texto`.
- [ ] **Passo 2:** implementar e rodar → PASS. MenuBar acessível por teclado (Alt abre, setas navegam). Commit.

### Tarefa 7: Ferramentas de seleção e Alfa Instantâneo

**Arquivos:** `src-tauri/src/image/select.rs`, `src-tauri/src/commands/edit.rs` (acrescentar), `src/select/{tools.ts,lasso.ts,lasso.test.ts,SelectionLayer.tsx}`.

**Interfaces:**
- Produz (Rust): `fn instant_alpha(img: &RgbaImage, seed: (u32,u32), tolerance: f32 /*0..=1*/) -> Mask::Bitmap` (*flood fill* contíguo pela distância em Lab, limite = `tolerance*100` ΔE); `fn snap_lasso(img, points) -> Vec<(f32,f32)>` (cada ponto move até o máximo de gradiente Sobel num raio de 8 px, e os pontos são reamostrados a cada 4 px); `fn mask_to_alpha(mask, w, h) -> GrayImage`; e `copy_region`. As operações `Erase`/`MakeTransparent` já existem na Tarefa 4.
- Produz (TS): `type SelectionTool = 'rect' | 'ellipse' | 'lasso' | 'smartLasso' | 'instantAlpha'`; `selection` no store `ui` (`Mask | null`, em coordenadas da imagem); `invertMask(mask, w, h): Mask`; `simplifyPath(points, epsilon): Point[]` (Ramer–Douglas–Peucker).
- Alfa Instantâneo: clique e arraste a partir do ponto. A distância arrastada (0–300 px) mapeia a tolerância 0–1 e a prévia da máscara aparece em magenta translúcido (`instant_alpha` com *throttle* de 60 ms). Ao soltar, Enter ou Delete aplica `MakeTransparent`. Se o formato não tiver alfa (JPEG), avisa que o resultado será salvo como PNG ou exportado.

- [ ] **Passo 1: testes Rust que falham:** `instant_alpha` numa imagem com fundo branco e quadrado vermelho, com semente no branco e tolerância 0.1 → a máscara cobre exatamente o branco contíguo e não o vermelho; `tolerancia_zero_so_cor_identica`; `snap_lasso_gruda_na_borda` (borda vertical em x=50, pontos em x=45 → x∈[49,51]).
- [ ] **Passo 2: testes TS que falham:** `simplifyPath` reduz uma linha reta de 100 pontos a 2; `invertMask(Rect)` → Bitmap com a contagem de pixels complementar.
- [ ] **Passo 3:** implementar. SelectionLayer com formigas marchando (`lineDashOffset` animado) e alças para redimensionar a seleção retangular/elíptica. Recortar (Ctrl+K) usa o *bounding box* da seleção (e, numa seleção não retangular, também aplica `MakeTransparent` fora da máscara). Copiar/Recortar/Apagar/Colar: Colar cria uma anotação de imagem móvel (precisa da Tarefa 8; até lá, desabilitado). Rodar → PASS. Commit.

### Tarefa 8: Marcação (anotações vetoriais)

**Arquivos:** `src/markup/{model.ts,history.ts,render.ts,sketch.ts,MarkupBar.tsx,SignaturePanel.tsx,tools/*.ts}`, `src/markup/*.test.ts`.

**Interfaces:**
- Produz: `type Annotation = { id: string; kind: 'line'|'arrow'|'rect'|'roundRect'|'oval'|'bubble'|'star'|'polygon'|'freehand'|'text'|'loupe'|'highlight'|'signature'|'image'; geom: ...; style: Style }`, com `Style { stroke: string; fill: string | null; width: number; dash: 'solid'|'dashed'|'dotted'; arrowStart: ArrowEnd; arrowEnd: ArrowEnd; shadow: boolean; font?: { family, size, color, bold, italic, underline, align } }`; `AnnotationDoc { items: Annotation[] }` por documento (no store `docs`, por `DocId`); `history.ts` com `push(doc)`, `undo()`, `redo()`, integrada ao desfazer global (a pilha unificada intercala ações de anotação e `Op` do Rust por *timestamp*); `render(ctx, items, viewToImage, source?: ImageBitmap)` (a Lupa precisa dos pixels de baixo); `flattenToPng(items, w, h, source): Promise<Uint8Array>` (canvas *offscreen* em resolução cheia → `Op::Composite`); `recognize(points: Point[]): { kind: 'line'|'arrow'|'rect'|'oval'|'star'|'bubble'; geom } | null` em `sketch.ts`.
- Lupa: círculo com alça verde (aumento 1×–8×) e azul (raio). Realce: retângulo/oval nítido e o resto escurecido em 50 % (só um realce ativo por vez é suficiente, mas vários se somam na mesma máscara). Balão: retângulo arredondado com cauda arrastável. Estrela: pontas 3–20 por alça. Polígono: lados 3–20.
- Assinatura: painel com abas **Desenhar** (canvas, suavizado com Catmull-Rom) e **Importar Imagem** (remove fundo claro com `instant_alpha` em tolerância 0.15). Fica salva em `plugin-store` (`signatures.json`, PNG em base64, até 10). Inserir uma assinatura cria uma anotação `signature`.
- As anotações continuam editáveis (seleção, mover, alças, estilo e Delete) até salvar ou exportar, quando são achatadas com `Op::Composite`.

- [ ] **Passo 1: testes que falham** (`sketch.test.ts`): um traço circular de 64 pontos é reconhecido como `oval`; quatro segmentos retos fechados → `rect`; uma linha quase reta → `line`; uma linha reta com um "V" na ponta → `arrow`; um rabisco aleatório (seed fixa) → `null`.
- [ ] **Passo 2: testes que falham** (`model.test.ts`/`history.test.ts`): `mover anotação desfaz para a posição anterior`, `alterar estilo de várias selecionadas`, `serializa e desserializa sem perda`, `flattenToPng gera PNG do tamanho da imagem` (jsdom + `canvas` npm ou mock de OffscreenCanvas; se usar mock, afirmar as chamadas de desenho).
- [ ] **Passo 3:** implementar o modelo, os tools, o render e a MarkupBar (ferramentas na ordem do Preview: seleção, esboço, desenho, formas ▸, texto, assinatura ▸, espessura, borda, preenchimento, estilo de texto, girar, recortar). Rodar → PASS.
- [ ] **Passo 4: E2E** `markup.e2e.ts`: desenhar uma seta, um texto e uma lupa, desfazer, refazer, exportar PNG e conferir que o pixel no centro da seta tem a cor do traço. Commit.

### Tarefa 9: Ajustar Cor e Ajustar Tamanho

**Arquivos:** `src-tauri/src/image/color.rs`, `src-tauri/src/commands/edit.rs` (acrescentar `preview_adjust`, `histogram`, `auto_levels`), `src/adjust/{AdjustColorPanel.tsx,ResizeDialog.tsx,units.ts,units.test.ts}`.

**Interfaces:**
- Produz (Rust): `fn adjust(img: &RgbaImage, a: &ColorAdjust) -> RgbaImage`, com a ordem fixa níveis → exposição (`2^ev`, ev ∈ [−3, 3]) → contraste (curva S, [−1, 1]) → realces/sombras (máscaras de luminância, [−1, 1]) → temperatura/matiz (escala dos canais em torno de 6500 K, [−1, 1]) → saturação (em HSL, [−1, 1]) → sépia ([0, 1]) → nitidez (*unsharp mask* raio 1, [0, 1]); `fn histogram(img) -> Histogram`; `fn auto_levels(img) -> ColorAdjust` (black/white nos percentis 0,5 % e 99,5 % da luminância). `Op::Adjust` passa a funcionar em `ops::apply`.
- Produz (TS): `units.ts` com `toPixels(value, unit: 'px'|'%'|'cm'|'mm'|'in', dpi, base)` e `fromPixels`, e `RESIZE_PRESETS` (320×240, 640×480, 800×600, 1024×768, 1280×1024, 1920×1080, 3840×2160).
- AdjustColorPanel: janela flutuante com o histograma (canvas) e alças de níveis, os sliders, os botões **Ajuste Automático** e **Redefinir Tudo**, e a prévia ao vivo via `preview_adjust` (*throttle* 50 ms, tamanho do viewport). Ao fechar com mudanças, faz `apply_op(Adjust)`.
- ResizeDialog: largura/altura com unidade, resolução, checkboxes "Redimensionar proporcionalmente" e "Reamostrar imagem" (desmarcado = só muda o DPI, `Op::Resize` com w/h iguais e `dpi`), presets e "Tamanho resultante: X MB" (w×h×4 da prévia e estimativa real via `estimate_size` quando a Tarefa 11 existir).

- [ ] **Passo 1: testes Rust que falham:** `ajuste_neutro_e_identidade` (todos 0 → bytes iguais); `exposicao_mais_1_dobra_linear` (cinza 0,25 linear → 0,5 ± 0,01); `saturacao_menos_1_gera_cinza`; `auto_levels_estica_histograma` (imagem com valores entre 50 e 200 → black ≈ 50 e white ≈ 200); `histogram_soma_igual_pixels`.
- [ ] **Passo 2: testes TS que falham:** `toPixels(2.54,'cm',300) === 300`, `toPixels(50,'%',_,1000) === 500`, `fromPixels(300,'in',150) === 2`, `proporcional mantém razão` (função `linkDims`).
- [ ] **Passo 3:** implementar e rodar → PASS. Commit.

### Tarefa 10: Inspetor de informações

**Arquivos:** `src-tauri/src/image/metadata.rs`, `src-tauri/src/commands/meta.rs`, `src/inspector/Inspector.tsx`.

**Interfaces:**
- Produz: `Metadata { general: General { width, height, dpi: Option<(f32,f32)>, color_model: String, profile: Option<String>, depth: u8, has_alpha: bool, file_size: u64, created: Option<String>, modified: String }, exif: Vec<(String,String)>, iptc: Vec<(String,String)>, gps: Option<Gps { lat: f64, lon: f64, alt: Option<f64> }>, keywords: Vec<String> }`. O nome do perfil ICC vem da tag `desc`. EXIF com rótulos legíveis (`kamadak-exif` `display_value`). IPTC lido do JPEG APP13. A lista de anotações vem do front.
- Inspetor: painel flutuante com abas Geral, EXIF, IPTC, GPS (coordenadas em graus e minutos e o botão "Abrir no mapa" → `https://www.openstreetmap.org/?mlat=..&mlon=..` via `plugin-opener`), Palavras-chave (editáveis: gravadas como IPTC Keywords / XMP `dc:subject` ao salvar) e Anotações (lista clicável que seleciona a anotação).

- [ ] **Passo 1: testes que falham:** `metadata_jpeg_exif` (fixture com Make/Model/GPS conhecidos → valores e `gps.lat` ± 1e-5); `png_sem_exif_retorna_vazio`; `perfil_icc_nome` (fixture com sRGB embutido → `"sRGB IEC61966-2.1"`).
- [ ] **Passo 2:** implementar e rodar → PASS. Commit.

### Tarefa 11: Arquivo — salvar, exportar, reverter, imprimir, capturar

**Arquivos:** `src-tauri/src/image/encode.rs`, `src-tauri/src/commands/{file.rs,capture.rs}`, `src/file/{ExportDialog.tsx,fileActions.ts,unsaved.ts,unsaved.test.ts}`.

**Interfaces:**
- Produz (Rust): `fn encode(img: &RgbaImage, opts: &ExportOptions, meta: &MetaCarry) -> Result<Vec<u8>>`, em que `MetaCarry { exif: Option<Vec<u8>> /*Orientation reescrita para 1*/, icc, iptc_keywords }` é omitido com `strip_metadata`. JPEG com `quality` padrão = estimada pelas tabelas de quantização do original, ou 90. HEIC via `libheif-rs`, AVIF via `ravif`, WebP com perda via `webp`, JP2/EXR se houver crate adequada (senão o formato fica oculto no diálogo e registrado no CHANGELOG, conforme a spec §13.4).
- `save(id)`: se `writable` e o formato for gravável (JPEG, PNG, TIFF, WebP, HEIC, AVIF, BMP; não RAW/PSD/SVG/ICO/GIF animado) → grava atomicamente (arquivo temporário na mesma pasta + `rename`), atualiza `saved_len` e guarda `last_saved` para "Reverter para o Último Salvo". Senão → `NeedsExport`. Antes de gravar, compara o `mtime`/tamanho com os da abertura. Se mudou ou sumiu → `AppError{code:'changed_on_disk'}`.
- `revert(Original)` volta às `ops` vazias sobre o arquivo como estava na abertura (mantém o `Decoded` da abertura). `LastSaved` relê do disco.
- Vigia o arquivo aberto (`notify`): evento `doc-changed-on-disk { id, removed: bool }` → a interface mostra a faixa "O arquivo foi alterado fora do app" com os botões Recarregar/Ignorar.
- `capture_screen(mode: 'selection'|'window'|'screen')`: portal `org.freedesktop.portal.Screenshot` (`interactive=true` para seleção ou janela), abrindo o resultado como um novo documento sem caminho (`writable=false`, Salvar → Exportar). `new_from_clipboard`: lê a imagem do `plugin-clipboard-manager`.
- Imprimir: gera PNG em resolução cheia num arquivo temporário e abre o diálogo de impressão do sistema via `webview.print()` numa página interna `print.html` que exibe só a imagem (opções de ajustar à página e orientação em CSS `@page`).
- Exportar Selecionadas: aplica o mesmo `ExportOptions` (+ redimensionar opcional) a todos os selecionados na barra lateral, para uma pasta escolhida, com barra de progresso.
- `unsaved.ts`: `confirmClose(docs: DocInfo[]): Promise<'save'|'discard'|'cancel'>`, ligado ao `onCloseRequested` da janela, ao fechar um documento e à navegação da pasta (Tarefa 5).
- ExportDialog: formato, qualidade (slider), profundidade 16 bits (TIFF/PNG), alfa, remover metadados, tamanho estimado ao vivo (`estimate_size`, *debounce* de 300 ms) e nome/pasta.

- [ ] **Passo 1: testes Rust que falham:** `salvar_jpeg_preserva_exif_e_zera_orientacao` (abrir `rgb.jpg` com Orientation=6, girar, salvar → reabrir: dimensões giradas, Orientation=1, Make/Model preservados); `salvar_e_atomico` (o arquivo não fica truncado se o encode falhar: injetar erro); `salvar_raw_pede_exportar`; `salvar_em_caminho_com_acento`; `arquivo_removido_retorna_changed_on_disk`; `arquivo_modificado_externamente_retorna_changed_on_disk`; `strip_metadata_remove_gps`; `exporta_cada_formato_e_reabre` (para cada formato suportado, as dimensões batem); `estimate_size_aproxima` (±10 % do encode real).
- [ ] **Passo 2: testes TS que falham:** `confirmClose([])` resolve `'discard'` sem diálogo; com um doc sujo, mostra o diálogo com o nome do arquivo.
- [ ] **Passo 3:** implementar. Duplicar abre uma cópia em memória sem caminho, e Salvar pede o nome. Renomear e Mover Para… usam `rename`, com fallback de copiar+remover entre discos. "Abrir com…" e "Mostrar na Pasta" usam `plugin-opener` (`revealItemInDir`). Rodar → PASS.
- [ ] **Passo 4: E2E** `file.e2e.ts`: girar, fechar, ver o diálogo de não salvo, Cancelar; Salvar; reabrir girado; Exportar para WebP; o arquivo existe. Commit.

### Tarefa 12: Preferências, idiomas e Sobre

**Arquivos:** `src/prefs/PreferencesDialog.tsx`, `src/store/prefs.ts`, `src/store/prefs.test.ts`, `src/i18n/{index.ts,pt-BR.json,en.json}`, `src/i18n/i18n.test.ts`.

**Interfaces:**
- Produz: `Prefs { background: 'window'|'black'|'white'|'gray'|'custom'; customBg: string; browseFolder: boolean; openBehavior: 'fit'|'actual'; slideshowSeconds: number; autoUpdate: boolean; lastUpdateCheck: string | null; skippedVersion: string | null; nativeDecorations: boolean; language: 'system'|'pt-BR'|'en'; recent: string[] /*máx 20*/ }`, persistido em `plugin-store` (`prefs.json`) com padrões e migração tolerante a chaves desconhecidas.
- Sobre: logo, versão (`getVersion()`), licença MIT e link do repositório.

- [ ] **Passo 1: testes que falham:** `prefs carrega padrões quando arquivo ausente`, `ignora chave inválida mantendo padrão`, `recent sem duplicatas e máx 20`, `i18n: pt-BR e en têm exatamente as mesmas chaves` (recursivo), `nenhuma string visível hardcoded` (lint customizado simples: regex em `src/**/*.tsx` por texto JSX literal com letras, com lista de exceções).
- [ ] **Passo 2:** implementar e rodar → PASS. Commit.

### Tarefa 13: Fechamento de etapa — suíte completa, E2E no CI e README com prints **[PUSH]**

**Arquivos:** `.github/workflows/ci.yml` (job E2E), `scripts/screenshots.mjs`, `docs/screenshots/*.png`, `README.md`, `docs/testes/{guia.md,armadilhas.md,bugs.md}`, `CHANGELOG.md`.

- [ ] **Passo 1:** rodar a skill `simplify` sobre o código alterado desde o último fechamento. Aplicar o que ela apontar, salvo o que mudaria comportamento, e registrar o que foi pulado.
- [ ] **Passo 2:** rodar a skill `testes-suite-padrao` como **caça a bugs** (cobrindo os itens do Foco de revisão). Cada bug encontrado recebe um teste que o reproduz, a correção e o registro em `docs/testes/bugs.md` (sintoma → causa → correção → teste → lição).
- [ ] **Passo 3:** job E2E no CI: `xvfb-run` + `tauri-driver` + `webkit2gtk-driver` contra o build release.
- [ ] **Passo 4:** `screenshots.mjs` abre fixtures de demonstração (fotos de domínio público em `e2e/demo/`, com a origem registrada) e captura: janela principal com miniaturas (tema claro e escuro), folha de contatos, barra de marcação com anotações, Ajustar Cor, Ajustar Tamanho, Inspetor, Exportar, Alfa Instantâneo em uso e o diálogo de atualização. Também um GIF curto (`ffmpeg` a partir de frames) do fluxo abrir → anotar → exportar.
- [ ] **Passo 5:** README em pt-BR: logo, *badges* (release, CI, licença), GIF, descrição, seções por função com print e explicação (mesmos grupos da spec §5), tabela de atalhos (gerada de `keymap.ts` por script, para não divergir), formatos suportados, instalação (Fedora `sudo dnf install ./gera-view-image-X.rpm`, Ubuntu/Debian `sudo apt install ./gera-view-image_X_amd64.deb`, AppImage `chmod +x` e executar), como funciona a atualização automática, como compilar, como lançar versão (`npm run release`) e licença. Também a descrição e os *topics* do repositório via `gh repo edit` (`image-viewer`, `linux`, `tauri`, `rust`, `appimage`, `preview`).
- [ ] **Passo 6:** CHANGELOG, `npm run release 1.0.0` (ou `0.x` se a paridade ainda não estiver completa; listar no CHANGELOG o que falta) e `git push --follow-tags`. Conferir o release com os 3 pacotes e o `latest.json`. Instalar o `.rpm` e o AppImage desta versão nesta máquina e verificar se o app anterior se atualiza.

---

## Ordem e paralelismo

```
0 ─┬─► 1 ─┬─► 2 ─────────────────────────────────────┐
   │       └─► 3 ──────────────────────────────┐       │
   └─► 4 ─┬─► 5 ─► 6 ─► 12 ──────────────────┤       │
          ├─► 7 ─┬─► 8 ─┐                    ├─► 13 ◄┘
          ├─► 9 ─┴──────┴─► 11 ──────────────┘
          └─► 10 ──────────────────────────────┘
```
- 0 é bloqueante (validação WebKitGTK). 1 e 2 podem rodar em paralelo depois da 0, exceto o passo 3 da Tarefa 2 (`tauri.conf.json`), que espera os ícones da 1. 3 e 4 também podem rodar em paralelo (arquivos distintos, worktrees).
- Depois da 4: 5, 7, 9 e 10 em paralelo (worktrees). Em seguida 6 e 8, depois 11 e 12, e por fim 13.
