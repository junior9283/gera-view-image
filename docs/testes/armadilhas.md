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
- **Binário release sem `custom-protocol`.** `cargo build --release` sem `--features tauri/custom-protocol` tenta
  carregar o `devUrl` e nunca chega ao `render_view`. Use o `npm run tauri build` ou passe a feature.

## E2E

- **No Wayland, rAF e `ResizeObserver` não disparam na janela do tauri-driver.** O `data-scale` nunca aparece e os
  specs esperam até o timeout. Rode num X virtual:
  `env -u WAYLAND_DISPLAY GDK_BACKEND=x11 xvfb-run -a -s "-screen 0 1280x900x24" npm run test:e2e`.
- **`markup.e2e.ts` só passa no build com `VITE_E2E=1`** (gancho `window.__gviMarkup`). O mesmo build expõe
  `window.__gviE2E` (comandos e diálogo de atualização) para `scripts/screenshots.mjs`. O build normal não tem
  nenhum dos dois.
- **Portas.** Execuções paralelas colidem na 4444 do WebKitWebDriver: use `GVI_E2E_PORT` (4445/4446/4447; as
  capturas usam 4448).
- **Movimentos do WebKitWebDriver depois do `down` chegam com coordenadas erradas** (e `origin: elemento` é
  tratado como o canto, não o centro). O primeiro ponto do arrasto fica certo e os seguintes vão para outro
  lugar: setas e retângulos saem tortos, a lupa fica enorme. Os specs só contam anotações, então passam; para
  posições exatas (prints), use eventos reais do X com `xdotool` (`scripts/screenshots.mjs`).
- **Sem compositing, o WebKit no Xvfb deixa regiões sem redesenhar** (tema escuro sai preto, o canvas fica com o
  quadro antigo). Para prints, rode com `GVI_GPU_ACCEL=1` (padrão do `screenshots.mjs`) e capture o framebuffer
  do X (`import -window root`): o snapshot do WebDriver devolve o canvas desatualizado.
