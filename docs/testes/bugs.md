# Registro de bugs

Formato: sintoma, causa, correção, teste, lição.

## Sair com edição em outra janela parecia travar (Lote 12, antes de publicar)
- **Sintoma (Wayland aninhado):** Ctrl+Q numa janela sem edições, com outra não salva atrás: a da frente ficava com o véu "Fechando a janela…", Esc não fazia nada e a pergunta ficava escondida.
- **Causa:** o Wayland não deixa o app trazer outra janela para a frente sem um gesto do usuário nela; o véu não avisava nem cancelava.
- **Correção:** véu próprio da saída (`quitting`), que diz onde responder e cancela (botão e Esc). `cancel_quit` encerra a pergunta em andamento; um sim que chega depois devolve a janela ao normal em vez de deixá-la selada.
- **Teste:** `TabBar.test.tsx` (véu), `closing.test.ts` (responde uma vez só), `saida_cancelada_por_outra_janela_encerra_a_pergunta` (`window.rs`) e conferência em kwin aninhado.
- **Lição:** nada pode depender de trazer uma janela para a frente no Wayland.

## Textos do Inspetor: apagar deixava outra língua, e acentos viravam `\xNN` (Lote 9, antes de publicar)
- **Sintoma (revisões):** (1) apagar o título tirava só o item padrão do XMP e o texto em outra língua voltava a aparecer; com o mesmo texto em `x-default` e `en-US`, o pacote era trocado e perdia a classificação. (2) Editar só o título gravava o autor `José` do EXIF como `Jos\xc3\xa9` no XMP novo. (3) Recarregar e depois Reverter ao Original, ou apagar e gravar em AVIF/HEIC, trazia o autor apagado de volta. (4) Tirar texto do EXIF podia zerar o início de uma tabela colada no fim de outra.
- **Causa:** (1) apagar por item, não por propriedade. (2) O `display_value` do crate `exif` escapa tudo fora do ASCII básico, e o IPTC Latin-1 era lido como UTF-8. (3) Os marcadores do que já foi gravado pertencem à origem da abertura, mas não acompanhavam a troca de origem. (4) O ponteiro do próximo IFD era conferido só contra os valores da própria tabela.
- **Correção:** `xmpedit::edit` apaga a propriedade inteira e, ao editar, as cópias do texto trocado; `metaedit::text_bytes` (UTF-8, senão Latin-1) na leitura do EXIF e do IPTC; semeadura só quando havia um pacote que se perdeu; `DocStore::meta_source_changed`; `exifscrub::check_slots` e corte da cadeia depois do IFD1.
- **Teste:** `xmp_padrao_repetido_*`, `apagar_sem_x_default_*`, `textos_com_acento_*`, `sem_xmp_original_*`, `reverter_ao_original_depois_de_trocar_a_origem_*`, `apagar_e_gravar_em_avif_*`, `tabela_colada_*`, `cadeia_e_cortada_*`, `valor_sobre_o_ponteiro_*`.
- **Lição:** testar texto sempre com acento e em mais de uma língua; só ASCII esconde erro de codificação.

## Texto editado no Inspetor voltava ao arquivo (Lote 9)
- **Sintoma (revisões):** o autor, a descrição ou o título apagados ou trocados reapareciam no EXIF a partir do 2º Salvar, no Exportar, no Salvar Como e no Duplicar, e a aba mostrava o valor antigo depois de salvar. Em AVIF/HEIC o autor já apagado voltava quando havia um autor novo pendente. Apagar um título sem `x-default` não apagava nada, e o XMP era editado por busca de texto (quebrava com `dc:ti<dc:title/>tle`, tab antes do atributo e outro prefixo).
- **Causa:** o EXIF guardado na abertura (`source.exif`) nunca muda, e a limpeza só rodava com edição pendente; o marcador de "já apagado" era encoberto pelo valor pendente; a edição do XMP não escolhia o mesmo item que a leitura exibe.
- **Correção:** o `DocStore` guarda por documento os campos já gravados e os aplica em toda gravação e na leitura dos metadados (copia no Duplicar, mantém ao Reverter, esquece ao fechar); o conjunto a limpar do EXIF é marcador mais pendente por formato; `exifscrub.rs` limpa o EXIF sem mover nada e sem zerar o que é mantido (ou descarta o EXIF e avisa); `xmpedit.rs` usa tokenizador, o mesmo seletor de item na leitura e na edição, pós-condição relendo o pacote e pacote novo com aviso quando não dá.
- **Teste:** `texto_apagado_nao_volta_ao_exif_*`, `autor_ja_apagado_nao_volta_ao_exif_do_avif_*`, `reverter_descarta_so_a_pendencia_*`, `edicao_que_cai_no_pacote_novo_*` (`src-tauri/tests/inspetor.rs`); `apagar_sem_x_default_*`, `bom_no_comeco_*`, `teto_de_*` e a mutação de bytes (`metaedit.rs`); `exifscrub.rs` (sub-IFD, IFD1, ponteiro omitido, valor que passa do fim).
- **Lição:** estado derivado do arquivo de abertura precisa ser reaplicado a cada gravação, não só quando há edição pendente; leitura e edição de um formato usam o mesmo seletor e o mesmo tokenizador; limpeza que falha tem que falhar fechada e avisar.

## Janela sumia e só aparecia a última região clicada (0.3.0 e 0.4.0)
- **Sintoma (usuário, KDE Wayland, Intel + Nvidia):** ao abrir uma imagem ou um menu, a janela sumia e só a última região redesenhada ficava visível.
- **Causa:** com a janela transparente (`transparent:true`), o WebKitGTK 2.54 apaga o resto da janela a cada redesenho parcial se o DMABUF **ou** o compositing estiver desligado. O app desligava os dois por padrão (entrada seguinte). Medido na 0.3.0, kwin aninhado:

| DMABUF | Compositing | Janela |
|---|---|---|
| desligado | desligado | some |
| desligado | ligado | some |
| ligado | desligado | some |
| ligado | ligado | inteira |

- **Por que a correção anterior não servia:** só trocou um modo quebrado por outro. Na época o DMABUF continuou desligado, então "ligar o compositing" nunca foi testado sozinho.
- **Correção:** `apply_webkit_workarounds` não desliga mais nada por padrão e define só `__NV_DISABLE_EXPLICIT_SYNC=1`: na Nvidia, sem ela, o app fecha com "Error 71 dispatching to Wayland display" (3/3 sem, 0/3 com). `GVI_GPU_ACCEL` deixou de existir. `GVI_SAFE_RENDER=1` ainda desliga os dois, mas abre a janela opaca (com ela o defeito não ocorre).
- **Teste:** `padrao_mantem_o_desenho_acelerado_e_so_desliga_o_explicit_sync` e `modo_de_seguranca_abre_janela_opaca` (`webkit.rs`) e `scripts/render-check.sh`, que reprova a 0.3.0. Ele roda em X11 sem GPU: não cobre o "Error 71" nem o Wayland, que foram conferidos com `kwin_wayland --virtual` nas duas placas.
- **Lição:** o defeito já tinha aparecido nas capturas e foi anotado como "armadilha do Xvfb". Desenho errado em teste é defeito do app até prova em contrário.

## Janela toda branca no app instalado (Wayland)
> Superada pela entrada acima: a correção descrita aqui causava o outro defeito.

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

### OpenEXR exportado com alfa reto
- **Sintoma:** um EXR semitransparente exportado aparecia com halo claro em outros programas (a especificação pede cor pré-multiplicada pelo alfa).
- **Causa:** `encode::exr` gravava a cor sem multiplicar, e o teste da época fixava esse valor.
- **Correção:** multiplica pelo alfa ao gravar; a leitura (`hdr::decode_exr`) desfaz.
- **Teste:** `exr_half_e_float` (`src-tauri/src/image/encode.rs`, valores corrigidos pela especificação) e `exr_exportado_volta_igual` (`src-tauri/tests/formatos.rs`).
- **Lição:** valor esperado se tira da especificação, não do que o código produz.
