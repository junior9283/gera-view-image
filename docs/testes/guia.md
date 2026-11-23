# Guia de testes

## Comandos
- `npm run test:release` (script de versão, `node --test`), `npm run lint`, `npm run typecheck`, `npm test` (Vitest/jsdom, `vmThreads`), `npm run test:rust`.
- Área de transferência de arquivos (ida e volta pelo GTK): `xvfb-run -a cargo test --test clipfiles -- --ignored`, com HOME e XDG_* temporários. Nunca na sessão do usuário: troca o que ele copiou.
- Instância única (duas execuções, um processo): `scripts/single-instance.sh <binário>` (Xvfb, barramento e HOME/XDG próprios).
- Scanner: os testes de `commands::scan` usam o `scanimage` falso `src-tauri/tests/fixtures/fake-scanimage`. Com o SANE instalado, o backend `test` (imagem sintética, sem hardware) roda no teste ignorado: crie uma pasta com `dll.conf` contendo `test` e uma cópia de `/etc/sane.d/test.conf` e rode `SANE_CONFIG_DIR=<pasta> cargo test --lib scanimage_real -- --ignored`.
- Build: `npm run tauri build -- --bundles deb,rpm,appimage` (exporte `TAURI_SIGNING_PRIVATE_KEY` e `_PASSWORD` a partir de `~/.tauri/gera-view-image.*` para gerar os `.sig`) (não usar `tauri dev` em paralelo: porta 1420).

## Marco 0: validação WebKitGTK (spec §13.2)
Máquina: KDE Plasma Wayland, Intel UHD + Nvidia GTX 1650 (híbrida). Binário release, JPEG 24 MP (6000x4000, 6,1 MiB, plasma ImageMagick).
Esta tabela foi medida só com o DMABUF desligado, modo que o app não usa mais por padrão: ver a primeira entrada de `bugs.md`. `GVI_SAFE_RENDER=1` volta ao desenho por software.

| GPU | decodificado | buffer pronto | imagem exibida (ms desde o início do processo) | Captura |
|---|---|---|---|---|
| Integrada (Intel) | 896 | 1170 | 1217 | janela com a imagem nítida, sem tela branca (confirmado visualmente) |
| Nvidia (`__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`) | 511-556 | 769-828 | 816-871 (3 execuções) | **não obtida**: ver abaixo |

- Nvidia: o app executou até `imagem exibida` (putImageData concluído, sem erro de console), mas o `spectacle -a` capturou outra janela do usuário (a janela do app não ficava ativa no Wayland), então não há confirmação visual. Capturas indevidas foram apagadas. Pendente: conferir a olho, ou capturar via KWin/ScreenCast.
- Zoom/pan fluidos: não avaliados de forma interativa (sem acesso a entrada na janela).
- Tempo de abertura (~0,8-1,2 s) fica acima da meta de 400 ms; o decode do image crate (24 MP) domina (0,5-0,9 s). Otimizar na Tarefa 4 (zune-jpeg com redução de escala/DCT scaling).

## Tarefa 4: abertura do JPEG de 24 MP (build release, GPU integrada)
- Núcleo isolado (`GVI_PERF_JPEG=... cargo test --release --test perf -- --ignored --nocapture`): prévia DCT 1/2 (3000x2000) aberta em 173-187 ms, 1º `render_view` em 184-200 ms, decode completo em segundo plano termina em 366-384 ms. Decode completo isolado (crate `image`/zune-jpeg): 196 ms.
- App inteiro (`GVI_TIMING=1 gera-view-image foto.jpg`, 3 execuções): argv aberto em 166-268 ms; 1º `render_view` (prévia) servido em **283-404 ms**; buffer em resolução cheia (evento `doc-updated`) em 405-531 ms. Antes (Tarefa 0): 1170 ms.
- O que domina agora é a subida do WebView (o decode roda em paralelo desde o `main`).
- **Leitura honesta:** 2 das 3 execuções deram 404 ms, ou seja, a meta de < 400 ms foi atingida só no limite e não com folga. O núcleo (prévia + 1º render em ~200 ms) não é mais o gargalo; o resto é a subida do GTK/WebKit até o JS chamar `startup_documents`. Ganhar mais exige mexer na subida do WebView (pintar a prévia antes do React, por exemplo), não no decode.
- Nova medição (rodada de correção 1, libheif embutida, `cargo build --release --features tauri/custom-protocol`, 3 execuções): argv aberto em 194-200 ms; 1º `render_view` em **343-355 ms**; resolução cheia em 474-494 ms. Dentro da meta, mas com menos de 60 ms de folga. Sem `custom-protocol`, o binário tenta carregar o devUrl e nunca chega ao `render_view`.

## Armadilhas
- `cargo fmt` e `cargo clippy --all-targets` sem avisos são esperados no Rust.
- O perfil release usa `panic = "unwind"`: pânico de decodificador vira erro `corrupt` só naquele documento (`decode::guarded`).
- Validar renderização/GPU com a janela transparente e sem decoração (como em produção) e num pacote instalado, sem variáveis de ambiente; o Marco 0 passou e o app instalado ainda ficava em branco (ver `bugs.md`).
- `bundle.category` do Tauri usa nomes do enum (`GraphicsAndDesign`), não da freedesktop; `Categories=` do `.desktop` vem do template próprio.
- Build release com LTO leva ~14 min com a máquina carregada; só o bundling falha ao final se a config estiver inválida.
- `npm create tauri-app` exige diretório vazio: gerar em pasta temporária e mover.
- `spectacle -a` no Wayland captura a janela ativa, que pode não ser o app testado.
- libheif é compilada estática (`embedded-libheif`, cmake), com o aom (AVIF) ligado do sistema (`libaom-dev`). O `build.rs` do `libheif-sys` força todos os codecs ON; o toolchain `src-tauri/cmake/libheif-codecs.cmake` (aplicado por `.cargo/config.toml` na raiz, via `CMAKE_TOOLCHAIN_FILE`) desliga o `find_package` de todos menos o AOM, então o resultado não depende dos `-dev` instalados. Ao mudar o toolchain, rode `cargo clean -p libheif-sys` (o cmake guarda cache). O HEIC usa o plugin libde265 da própria libheif, compilado pelo `build.rs` com o shim `native/heic/de265_dl.cc`, que faz `dlopen("libde265.so.0")` na primeira abertura de HEIC. O `libheif.pc` gerado quebra o `-L` num caminho com espaço ("GERA VIEW IMAGE"): localmente use `CARGO_TARGET_DIR` por um symlink sem espaços. Se o build já tinha achado um codec, rode `cargo clean -p libheif-sys` (o cmake guarda o cache).
- Pacotes: `depends` só `libaom3`/`libaom`; `libde265-0`/`libde265` em `recommends` (o Fedora oficial não tem libde265, só o RPM Fusion). `scripts/check-needed.sh` (CI e release) recusa NEEDED fora da allowlist e proíbe libde265, libjpeg, libopenjp2, libheif, dav1d e x265. O smoke roda `gera-view-image --version` em ubuntu:22.04, ubuntu:24.04, ubuntu:24.04 sem Recommends e fedora:latest (sem libde265).
- Testes de memória (`tests/robustez.rs`) usam `DocStore::with_limits` com orçamento pequeno e contam reservas/execuções do pipeline em vez de medir RSS.

## E2E (Tarefa 5): WebdriverIO + tauri-driver
- `npm run test:e2e` (`wdio.conf.ts`) roda contra o binário **release** (`$CARGO_TARGET_DIR/release/gera-view-image` ou `GVI_BINARY`). Build: `npm run build && cargo build --release --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml`.
- Portas: `tauri-driver --port 4445 --native-port 4545` (`TAURI_DRIVER_PORT` ou `GVI_E2E_PORT` muda as duas; nativa = porta + 100). O padrão do WebKitWebDriver (4444) colide com outras execuções em paralelo (T5 4445, T8 4446, T11 4447).
- **Build do E2E com `VITE_E2E=1`** (ex.: `VITE_E2E=1 npm run build && cargo build --release …`). Só nesse build existe o gancho `window.__gviMarkup` (`activeId`, `count`, `texts`, `flatten`) que o `markup.e2e.ts` usa para contar anotações e achatar; o build normal não o expõe.
- Se o `data-scale` nunca aparece e o rAF/`ResizeObserver` não disparam, a janela não está sendo apresentada (tela bloqueada/ociosa): o E2E não vale nessa condição, rode com a sessão gráfica ativa.
  Confirmado na Task 11 mesmo com `visibilityState=visible` e foco: no Wayland, a janela do tauri-driver pode não receber frames. Saída estável: rodar num X virtual, `env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s "-screen 0 1280x900x24" npx wdio run wdio.conf.ts` (viewer + file: 3 de 3 execuções passaram).
- `file.e2e.ts` regrava o arquivo: o `beforeSession` copia `Ação 1.jpg` para `$TMPDIR/gvi-e2e-*/Pasta com ação/` (caminho com espaço e acento), e o `afterSession` apaga a pasta.
- Os arquivos entram por `argv` (`tauri:options.args`); o spec espera os 3 itens na barra lateral antes de começar.
- Seletores estáveis: `data-testid` (`zoom-level` com `data-scale`, `doc-error`, `thumb-error`, `sidebar`), não textos (o idioma segue o sistema).
- WebdriverIO fica no 9: o 10 dá ERESOLVE com as dependências atuais. As vulnerabilidades do `npm audit` são todas transitivas do wdio (só dev); `npm audit --omit=dev` = 0.
- Vitest de componentes: `resetPrefsForTests()` volta o idioma para o do sistema (en no jsdom); fixe `setPrefs({ language: "pt-BR" })` depois do reset.
