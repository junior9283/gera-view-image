# Registro de bugs

Formato: sintoma, causa, correção, teste, lição.

## Janela toda branca no app instalado (Wayland)
- **Sintoma:** no app instalado (KDE Plasma Wayland, Intel + Nvidia), a janela ficava toda branca; só a região sob o mouse era redesenhada.
- **Causa:** janela transparente e sem decoração (`decorations:false`, `transparent:true`) com o WebKitGTK em modo compositing. Com `GVI_SAFE_RENDER=1` (`WEBKIT_DISABLE_COMPOSITING_MODE=1`) tudo renderizava.
- **Correção:** `apply_webkit_workarounds` define por padrão `WEBKIT_DISABLE_COMPOSITING_MODE=1` além de `WEBKIT_DISABLE_DMABUF_RENDERER=1`, respeitando valores existentes. `GVI_GPU_ACCEL=1` desliga os dois; `GVI_SAFE_RENDER` virou redundante.
- **Teste:** `define_compositing_por_padrao`, `respeita_compositing_existente`, `gpu_accel_desliga_ambos` (`src-tauri/src/platform/webkit.rs`).
- **Lição:** validar a GPU/renderização com a janela transparente e num pacote instalado, sem variáveis de ambiente; o Marco 0 não pegou o bug.

## Clicar numa anotação criava um passo vazio no desfazer
- **Sintoma:** selecionar uma anotação com um clique (com leve tremida do ponteiro) empilhava um "mover" sem efeito; o Ctrl+Z parecia não fazer nada.
- **Causa:** `moveItems(…, 0, 0)` devolvia objetos novos, e o `commit` só reconhece "sem mudança" pela identidade dos itens.
- **Correção:** `moveItems` devolve o mesmo array quando o deslocamento é zero.
- **Teste:** `deslocamento zero devolve o mesmo array` (`src/markup/model.test.ts`).
- **Lição:** em histórico por snapshot, transformações neutras devem preservar a identidade.

## Mover/Renomear podia substituir um arquivo e abrir as permissões
- **Sintoma (revisão):** `move_file` checava `exists()` e depois fazia `rename`, que sobrescreve em silêncio um destino criado nesse intervalo. Na cópia entre discos, o destino nascia com a umask (podia ficar legível por outros) e recebia o modo por caminho (TOCTOU). O temporário da gravação atômica tinha o mesmo padrão.
- **Correção:** `hard_link` (falha se o destino existir) e, sem ele, `copy_no_replace` com `create_new` + `mode(0o600)` + `File::set_permissions` pelo handle. O temporário do `write_atomic` nasce 0o600 quando regrava.
- **Teste:** `copia_entre_discos_nao_abre_permissoes`, `salvar_arquivo_privado_continua_privado`, `renomear_e_mover` (`src-tauri/tests/file.rs`).
- **Lição:** nunca “checar e depois agir” em caminhos; criar com `create_new` e o modo mais restrito e ajustar pelo descritor.

## Arrastos do E2E/prints caíam em posições erradas (infraestrutura de teste, Task 13)
- **Sintoma:** nos prints, a seta e o retângulo saíam com a segunda ponta fora da imagem e a lupa cobria o viewport inteiro, embora o `__gviMarkup.count()` desse 4.
- **Causa:** o WebKitWebDriver entrega os `pointermove` seguintes ao `down` com coordenadas erradas (e trata `origin: elemento` como o canto). O app calcula certo (`clientX - getBoundingClientRect().left`).
- **Correção:** `scripts/screenshots.mjs` arrasta com eventos reais do X (`xdotool`).
- **Teste:** conferência visual de `docs/screenshots/04-marcacao.png` (seta, retângulo, texto e lupa onde foram desenhados).
- **Lição:** E2E que só conta itens não prova posição; para geometria, verifique o pixel (como o `markup.e2e.ts`) ou use entrada real.

## Menores registrados na caça a bugs da Task 13 (não corrigidos)
- **Esc não fecha Ajustar Tamanho** (fecha Ajustar Cor e Exportar). Acessibilidade/consistência; P3.
- **XMP maior que ~64 KB some ao salvar JPEG:** `jpeg_segment` devolve `None` e o `unwrap_or_default` descarta o APP1 sem aviso (XMP estendido não implementado). P3.
- **Palavra-chave IPTC com mais de 32 767 bytes** é cortada no byte, podendo partir um caractere UTF-8. Irrealista; P3.
- **Vigia de alterações:** em teoria, um evento do próprio Salvar pode ser lido antes de o carimbo do disco ser atualizado (a janela de agrupamento de 300 ms torna isso improvável). P3.
- **Recarregar (faixa de alteração externa)** descarta anotações e ajustes não salvos sem perguntar; é ação explícita do usuário. P3.

## Salvar apagava as etiquetas e outros xattr `user.*` do arquivo (Lote 5)
- **Sintoma (achado ao implementar as etiquetas):** etiqueta posta pelo Dolphin (`user.xdg.tags`) sumia depois do Salvar.
- **Causa:** a gravação atômica (`write_atomic`) grava um temporário e faz `rename` sobre o original; o arquivo novo nasce sem os atributos estendidos.
- **Correção:** `doc::finder::overwrite` lê os `user.*` antes e os grava no arquivo novo (Salvar e Exportar por cima). O mesmo ponto guarda a versão anterior.
- **Teste:** `sobrescrever_mantem_atributos_de_usuario` (`src-tauri/src/doc/finder.rs`).
- **Lição:** troca atômica por `rename` muda o inode: tudo o que é do inode (xattr, ACL, dono, hard links) precisa ser levado de propósito.

## TIFF sem unidade de resolução era lido como 1 ppp (Lote 11)
- **Sintoma (achado pelo teste do PDF de TIFF com duas páginas):** a página de 80×40 px saía no PDF com 5760×2880 pontos (2 m de largura).
- **Causa:** `tiff_dpi` ignorava `ResolutionUnit = 1` (sem unidade: X/YResolution são só a proporção do pixel) e tratava o 1/1 gravado pelo codificador como 1 ppp.
- **Correção:** com unidade 1, o documento fica sem ppp (a página usa 72).
- **Teste:** `pdf_tem_uma_pagina_por_imagem_e_por_pagina_de_tiff` (`src-tauri/tests/print.rs`).
- **Lição:** metadado numérico com unidade só vale depois de conferir a unidade.

## ICO exportado de imagem opaca não reabria (Lote 11, antes de publicar)
- **Sintoma (achado pelo teste de ida e volta):** "The PNG is not in RGBA format!" ao reabrir o ICO de uma imagem sem alfa.
- **Causa:** o `IcoEncoder` embute o PNG como veio (RGB), e leitores de ICO exigem RGBA de 32 bits.
- **Correção:** o ICO é sempre codificado em RGBA.
- **Teste:** `ico_tga_e_psd_voltam_identicos` (`src-tauri/src/image/encode.rs`).
- **Lição:** todo formato de exportação precisa de teste de ida e volta, com e sem alfa.

## Correções da revisão do Lote 11 (antes de publicar)

### JPEG corrompido quando o EXIF passava do APP1
- **Sintoma:** exportar em JPEG com ppp, com um EXIF perto de 64 KB (ou vindo de PNG/TIFF), gravava um arquivo que não reabria direito, sem erro.
- **Causa:** gravar o ppp aumenta o EXIF, e o `JpegEncoder` (image 0.25.10) escreve o tamanho do APP1 em u16 sem conferir.
- **Correção:** se o EXIF com ppp não couber em 65 527 bytes, vale o anterior; se nem ele couber, sai sem EXIF.
- **Teste:** `exif_no_limite_do_app1_nao_corrompe_o_jpeg` (`src-tauri/src/image/encode.rs`).
- **Lição:** todo campo de tamanho fixo precisa de um teste no limite, reabrindo o arquivo.

### "Substituir" gravava em um arquivo diferente do avisado
- **Sintoma:** mudar nome, pasta ou formato com o aviso na tela e clicar em Substituir sobrescrevia o novo destino sem perguntar.
- **Causa:** o botão recalculava o destino e pulava a checagem.
- **Correção:** o aviso some quando o destino muda, e Substituir só vale se o destino for o do aviso.
- **Teste:** "Substituir só o arquivo do aviso" (`src/file/fileActions.test.tsx`).
- **Lição:** uma confirmação vale para o que foi mostrado, não para o estado de depois.

### Impressão seguinte herdava páginas, "por folha" e o arquivo de saída
- **Causa:** os ajustes da última impressão eram copiados inteiros.
- **Correção:** `print-pages`, `page-ranges`, `number-up` e `output-uri` não são lembrados.
- **Teste:** `impressao_nativa_exporta_para_pdf` (`src-tauri/tests/print.rs`).

### GIF com furos em áreas escuras
- **Sintoma:** foto escura com mais de 256 cores e poucos pixels transparentes saía com até metade da imagem transparente.
- **Causa:** o NeuQuant da crate `gif` quantiza o transparente junto, e o preto opaco cai no mesmo índice.
- **Correção:** `reserve_transparent` reduz só as cores opacas a 255 (com a busca exata da cor mais próxima: a do NeuQuant desviava até 49 níveis), e o transparente fica com um índice próprio (paleta exata).
- **Teste:** `gif_escuro_com_pouco_alfa_nao_fura` (`src-tauri/src/image/encode.rs`). A primeira versão do teste, com ruído numa só escala, não reproduzia; uma busca com 1 728 combinações achou 213.
- **Lição:** um teste que passa antes da correção não prova nada; varie tamanho, tons e proporção de alfa.

### Anotações carimbadas em todas as páginas do TIFF
- **Causa:** a anotação não tinha página, e `Op::Composite` valia para todos os quadros.
- **Correção:** `Annotation.page` (a da tela ao criar) e `Op::Composite { frame }`; as camadas são geradas por página (`annotationLayers`).
- **Teste:** "anotações em TIFF de várias páginas" (`src/print/print.test.tsx`), "documento de várias páginas" (`src/markup/markup.test.tsx`) e `anotacao_so_sai_na_sua_pagina` (`src-tauri/tests/print.rs`).

### A página da anotação não chegava ao Rust (segunda revisão)
- **Sintoma:** no app, a anotação continuava em todas as páginas, com todos os testes verdes.
- **Causa:** `toWire` (`src/ipc/commands.ts`) remontava `data` só com `png` e descartava `frame`; os testes da interface simulavam `ipc.applyOp`, e os do Rust partiam do JSON pronto.
- **Correção:** `data: { ...op.data, png }`.
- **Teste:** `src/ipc/commands.test.ts` e `src/markup/pages.test.ts`, que vai da ação até o `invoke`.
- **Lição:** quem simula a fronteira não a testa; pelo menos um teste por campo novo precisa atravessá-la.

### Gravar uma página consumia as anotações das outras (segunda revisão)
- **Sintoma:** Exportar, Salvar Como ou Duplicar e exportar um TIFF de várias páginas achatava todas as anotações, mas só a página 1 ia para o arquivo; o documento podia ficar limpo e as outras se perdiam ao fechar. Cancelar o Exportar aberto pelo Salvar também as deixava achatadas.
- **Causa:** o achatamento não sabia qual página seria gravada e rodava antes de se saber que o Salvar iria para o Exportar.
- **Correção:** `flattenAnnotations(id, page)` consome só a página gravada (a exibida); `Document::mark_saved` não deixa limpo um documento com anotação achatada fora do arquivo; aviso ao usuário; Duplicar copia as anotações editáveis; `saveDoc` confere `writable` antes de achatar.
- **Teste:** `src/markup/pages.test.ts`, `anotacao_fora_do_arquivo_mantem_o_documento_sujo` e `exportar_e_copiar_a_pagina_pedida` (`src-tauri/tests/print.rs`).
- **Lição:** "consumir" um estado editável exige saber exatamente o que o destino grava.

### ppp absurdo do arquivo na página do PDF e na impressão
- **Correção:** ppp não finito ou fora de 1 a 10 000 é ignorado (72), nos dois eixos juntos para não distorcer.
- **Teste:** `ppp_fora_da_faixa_e_ignorado` (`src-tauri/src/image/pdf.rs`) e `escala_em_porcentagem_do_tamanho_natural` (`src-tauri/src/image/print_layout.rs`).
