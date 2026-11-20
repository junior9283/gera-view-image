# Guia de testes

## Comandos
- `npm run test:release` (script de versão, `node --test`), `npm run lint`, `npm run typecheck`, `npm test` (Vitest/jsdom, `vmThreads`), `npm run test:rust`.
- Build: `npm run tauri build -- --bundles deb,rpm,appimage` (exporte `TAURI_SIGNING_PRIVATE_KEY` e `_PASSWORD` a partir de `~/.tauri/gera-view-image.*` para gerar os `.sig`) (não usar `tauri dev` em paralelo: porta 1420).

## Marco 0: validação WebKitGTK (spec §13.2)
Máquina: KDE Plasma Wayland, Intel UHD + Nvidia GTX 1650 (híbrida). Binário release, JPEG 24 MP (6000x4000, 6,1 MiB, plasma ImageMagick).
Contornos aplicados por padrão: `WEBKIT_DISABLE_DMABUF_RENDERER=1` e `WEBKIT_DISABLE_COMPOSITING_MODE=1` (desligar ambos com `GVI_GPU_ACCEL=1`; `GVI_SAFE_RENDER=1` segue aceito, mas é redundante). Esta tabela foi medida só com o DMABUF desligado: ver bug em `bugs.md`.

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
- libheif é compilada estática (`embedded-libheif`, cmake), com o aom (AVIF) ligado do sistema (`libaom-dev`). **Não instale `libde265-dev`, `libx265-dev` nem `libdav1d-dev` no build:** o cmake da libheif liga todo codec que encontrar. O HEIC usa o plugin libde265 da própria libheif, compilado pelo `build.rs` com o shim `native/heic/de265_dl.cc`, que faz `dlopen("libde265.so.0")` na primeira abertura de HEIC. O `libheif.pc` gerado quebra o `-L` num caminho com espaço ("GERA VIEW IMAGE"): localmente use `CARGO_TARGET_DIR` por um symlink sem espaços. Se o build já tinha achado um codec, rode `cargo clean -p libheif-sys` (o cmake guarda o cache).
- Pacotes: `depends` só `libaom3`/`libaom`; `libde265-0`/`libde265` em `recommends` (o Fedora oficial não tem libde265, só o RPM Fusion). `scripts/check-needed.sh` (CI e release) recusa NEEDED fora da allowlist e proíbe libde265, libjpeg, libopenjp2, libheif, dav1d e x265. O smoke roda `gera-view-image --version` em ubuntu:22.04, ubuntu:24.04, ubuntu:24.04 sem Recommends e fedora:latest (sem libde265).
- Testes de memória (`tests/robustez.rs`) usam `DocStore::with_limits` com orçamento pequeno e contam reservas/execuções do pipeline em vez de medir RSS.
