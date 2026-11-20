# Guia de testes

## Comandos
- `npm run lint`, `npm run typecheck`, `npm test` (Vitest/jsdom, `vmThreads`), `npm run test:rust`.
- Build: `npm run tauri build -- --bundles appimage,rpm` (não usar `tauri dev` em paralelo: porta 1420).

## Marco 0: validação WebKitGTK (spec §13.2)
Máquina: KDE Plasma Wayland, Intel UHD + Nvidia GTX 1650 (híbrida). Binário release, JPEG 24 MP (6000x4000, 6,1 MiB, plasma ImageMagick).
Contorno aplicado por padrão: `WEBKIT_DISABLE_DMABUF_RENDERER=1` (desligar com `GVI_GPU_ACCEL=1`; `GVI_SAFE_RENDER=1` soma `WEBKIT_DISABLE_COMPOSITING_MODE=1`).

| GPU | decodificado | buffer pronto | imagem exibida (ms desde o início do processo) | Captura |
|---|---|---|---|---|
| Integrada (Intel) | 896 | 1170 | 1217 | janela com a imagem nítida, sem tela branca (confirmado visualmente) |
| Nvidia (`__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`) | 511-556 | 769-828 | 816-871 (3 execuções) | **não obtida**: ver abaixo |

- Nvidia: o app executou até `imagem exibida` (putImageData concluído, sem erro de console), mas o `spectacle -a` capturou outra janela do usuário (a janela do app não ficava ativa no Wayland), então não há confirmação visual. Capturas indevidas foram apagadas. Pendente: conferir a olho, ou capturar via KWin/ScreenCast.
- Zoom/pan fluidos: não avaliados de forma interativa (sem acesso a entrada na janela).
- Tempo de abertura (~0,8-1,2 s) fica acima da meta de 400 ms; o decode do image crate (24 MP) domina (0,5-0,9 s). Otimizar na Tarefa 4 (zune-jpeg com redução de escala/DCT scaling).

## Armadilhas
- `npm create tauri-app` exige diretório vazio: gerar em pasta temporária e mover.
- `spectacle -a` no Wayland captura a janela ativa, que pode não ser o app testado.
