# Armadilhas conhecidas

Complementa a seção "Armadilhas" de `guia.md`. Formato: sintoma → causa → o que fazer.

## Build

- **`libheif.pc` quebra com espaço no caminho.** O `.pc` gerado pela libheif embutida escreve `-L<target>/…`
  sem aspas; com o projeto em `/mnt/ssd/Documentos/APP/GERA VIEW IMAGE`, o linker recebe pedaços do caminho.
  Use um `CARGO_TARGET_DIR` **sem espaço** (ex.: `/mnt/ssd/gvi-build/dev`). No CI o caminho não tem espaço.
- **AVIF local precisa de `libaom-devel`.** Sem os headers, o cmake da libheif não acha o AOM e o teste
  `core::decodifica_cada_formato` falha em `img.avif` ("compression format has not been built in"). Instale
  `libaom-devel` ou, sem root, `dnf download libaom-devel`, extraia headers, `.pc` e config cmake numa pasta e
  aponte `PKG_CONFIG_PATH` e `CMAKE_PREFIX_PATH` para ela. O CI instala `libaom-dev`.
- **Trocar os codecs exige `cargo clean -p libheif-sys`.** O cmake guarda o cache (`CMakeCache.txt`): depois de
  mudar `src-tauri/cmake/libheif-codecs.cmake`, instalar/remover um `-devel` de codec ou trocar o
  `PKG_CONFIG_PATH`, rode `cargo clean -p libheif-sys` (e `--release`) antes de compilar. O `rust-cache` do CI
  pode reter o mesmo cache: troque a `key` do cache se mexer nos codecs.
- **Disco.** Cada binário de teste em debug tem ~850 MB e o target passa de 15 GB. Nunca use `/tmp` (tmpfs) nem
  `~/.cache` para o target numa máquina com o `/home` quase cheio.
- **Gravar HEIC usa a libkvazaar por dlopen** (`native/heic/kvazaar_dl.cc`, soname `libkvazaar.so.7`, trocável
  por `GVI_LIBKVAZAAR_SONAME`, só nome). O `include/kvazaar.h` é o da 2.3.2; da 2.2 para a 2.3 só entrou
  `enable_logging_output` no fim do `kvz_config`, por isso `HAVE_KVAZAAR_ENABLE_LOGGING` fica **sem** definir
  (escrever o campo numa 2.2 passaria do fim da struct). Os testes que gravam HEIC são `#[ignore]` (o runner
  Ubuntu 22.04 não tem `libkvazaar7`). Para rodá-los sem root: `dnf download kvazaar-libs` (ou
  `apt download libkvazaar7`), extraia (`rpm2cpio … | cpio -idm`) e rode
  `LD_LIBRARY_PATH=<pasta>/usr/lib64 cargo test -- --include-ignored heic`. Sem a lib, o
  `tests/kvazaar_ausente.rs` confere que HEIC não grava e o Salvar leva ao Exportar.
- **Binário release sem `custom-protocol`.** `cargo build --release` sem `--features tauri/custom-protocol` tenta
  carregar o `devUrl` e nunca chega ao `render_view`. Use o `npm run tauri build` ou passe a feature.

## E2E

- **No Wayland, rAF e `ResizeObserver` não disparam na janela do tauri-driver.** O `data-scale` nunca aparece e os
  specs esperam até o timeout. Rode num X virtual:
  `env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s "-screen 0 1280x900x24" npm run test:e2e`.
- **No CI, os 3 specs falhavam no `before all` (portal D-Bus que não responde travava a janela).** Sintoma:
  `waitUntil` estoura em `viewer.e2e.ts:10`/`markup.e2e.ts:45`, depois `Request timed out`, `invalid session id`
  e `hyper::Error(IncompleteMessage)` no tauri-driver; até `elements` fica sem resposta. Causa: `window_theme`
  era comando **síncrono**, e o Tauri roda comando síncrono na thread principal do GTK. Ele chama o portal
  (`org.freedesktop.portal.Settings.ReadOne`) pelo zbus, que **não tem timeout de método por padrão**. No runner
  há barramento de sessão (o aviso `AT-SPI … ServiceUnknown` vem dele), e o portal não responde a tempo (inferido:
  a reprodução abaixo dá o mesmo log do CI, e a correção deixou o run 44846446415 verde): a thread principal ficava presa (o
  `service_start_timeout` do dbus é 120 s, e são até 4 chamadas), e o WebView e o WebDriver congelavam junto.
  Local passava porque o portal do desktop responde. Reprodução: Ubuntu 22.04 no podman com
  `dbus-run-session` e um `org.freedesktop.portal.Desktop.service` com `Exec=/bin/sleep 100000`.
  Correção (no app, vale para produção também): `#[tauri::command(async)]` em `window_theme` e
  `method_timeout` de 2 s na conexão do portal (`theme/watch.rs::portal_proxy`). Lição: nada de D-Bus,
  subprocesso ou outra E/S bloqueante em comando síncrono.
- **`markup.e2e.ts` só passa no build com `VITE_E2E=1`** (gancho `window.__gviMarkup`). O mesmo build expõe
  `window.__gviE2E` (comandos e diálogo de atualização) para `scripts/screenshots.mjs`. O build normal não tem
  nenhum dos dois.
- **Portas.** Execuções paralelas colidem na 4444 do WebKitWebDriver: use `GVI_E2E_PORT` (4445/4446/4447; as
  capturas usam 4448).
- **Movimentos do WebKitWebDriver depois do `down` chegam com coordenadas erradas** (e `origin: elemento` é
  tratado como o canto, não o centro). O primeiro ponto do arrasto fica certo e os seguintes vão para outro
  lugar: setas e retângulos saem tortos, a lupa fica enorme. Os specs só contam anotações, então passam; para
  posições exatas (prints), use eventos reais do X com `xdotool` (`scripts/screenshots.mjs`).
- **Região sem redesenhar no Xvfb era defeito do app**, não do Xvfb (ver a primeira entrada de `bugs.md`). Para
  prints, capture o framebuffer do X (`import -window root`): o snapshot do WebDriver devolve o canvas desatualizado.

## Arraste para fora (drag-source GTK)

- **Testar o arraste nativo no Xvfb precisa de um alvo GTK e de um WM.** Sem alvo de drop, o arraste só é
  cancelado; sem WM (ex.: `openbox &`), `xdotool windowquit` não fecha a janela, o `RunEvent::Exit` não vem e os
  temporários de `<cache>/drag/<pid>` ficam (a próxima abertura os apaga). Roteiro: uma janela Python/GTK3 com
  `drag_dest_add_uri_targets` que imprime as URIs, o app com duas imagens, `xdotool mousedown 1` na miniatura,
  `mousemove` em passos até a janela alvo e `mouseup 1`. O jsdom não cobre isso.

## Remover Fundo (segmentação)

- **O CI não baixa o U²-Netp.** Os testes de `image::segment` montam um ONNX mínimo (um `ReduceMean`, via
  `prost`) com a mesma entrada `[1, 3, 320, 320]`, e o download é testado contra um servidor HTTP local em
  `127.0.0.1`. O modelo real só roda no teste ignorado: baixe `u2netp.onnx` (URL e SHA-256 em
  `image/segment.rs`) e rode `GVI_U2NETP=/caminho/u2netp.onnx cargo test u2netp_real -- --ignored`.
- **O cancelamento é por janela** (`Epochs`): nos testes, cada um usa `Job::on(&contador_próprio)`, senão
  derruba o trabalho de outro teste rodando em paralelo.
