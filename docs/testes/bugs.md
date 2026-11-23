# Registro de bugs

Formato: sintoma, causa, correção, teste, lição.

## Scanner de rede hostil sem teto de saída (auditoria final do backend, P2)
- **Sintoma:** um dispositivo eSCL/sane-airscan anunciado pelo mDNS podia escrever sem parar na saída do `scanimage` (o disco enchia) e o arquivo era lido inteiro com `std::fs::read`; qualquer formato que o decodificador aceitasse virava documento.
- **Causa:** o laço do `Scans::run` só olhava o tempo; `scan_image` usava `decode::decode` (sem teto e por extensão/assinatura de qualquer formato).
- **Correção:** o laço confere o tamanho do arquivo de saída a cada 40 ms e mata o grupo acima de `MAX_SCAN_BYTES` (1 GiB: um A4 em 1200 ppp com 16 bits por canal tem ~840 MB crus); a leitura (`read_png`) também tem o teto e só aceita `detect_format == Png`. De quebra: a pasta `scan/<pid>` herdada de um processo antigo com o mesmo pid começa vazia (`drag::fresh_temp`), `private_dir` abre a pasta com `O_NOFOLLOW` e corrige a permissão pelo descritor (link plantado = erro) e a limpeza da saída também roda quando o Tauri esvazia a tabela de recursos (`commands::OnDrop`), caminho do reinício do atualizador que pula o `RunEvent::Exit`.
- **Teste:** `saida_sem_fim_e_interrompida_no_teto`, `png_acima_do_teto_que_terminou_antes_da_olhada_e_recusado`, `saida_que_nao_e_png_e_recusada`, `cancelar_mata_o_grupo_inteiro_com_o_neto`, `link_plantado_no_lugar_da_saida_nao_e_seguido` (`commands/scan.rs`, `scanimage` falso com `fake:flood`, `fake:jpeg` e `fake:tree`); `pasta_do_proprio_pid_herdada_comeca_vazia`, `pasta_privada_nao_segue_link_plantado` (`commands/drag.rs`); `limpeza_roda_quando_a_tabela_de_recursos_e_esvaziada` (`commands/mod.rs`).
- **Lição:** processo externo que fala com a rede é entrada hostil também no tamanho; teto no laço que espera e teto na leitura.

## XPKeywords e XPSubject antigos ficavam no EXIF (auditoria final do backend, P3, privacidade)
- **Sintoma:** trocar as palavras-chave (ou a descrição) gravava as novas no IPTC/XMP, mas o `XPKeywords` (0x9C9E) e o `XPSubject` (0x9C9F) do IFD0, que o Windows mostra como "Marcas" e "Assunto", continuavam com o valor antigo, também nas gravações seguintes.
- **Causa:** `scrub_texts` (`image/metaedit.rs`) só conhecia XPTitle, XPComment e XPAuthor; as palavras-chave nem chegavam ao conjunto de limpeza.
- **Correção:** descrição editada tira `XPSubject`; palavras-chave editadas (`MetaCarry::exif_keywords`) tiram `XPKeywords`, e o `DocStore` guarda que já as gravou (`keywords_written`, herdado no Duplicar e trocado com a origem como os outros marcadores).
- **Teste:** `exif_perde_xpkeywords_e_xpsubject_antigos` (`image/metaedit.rs`), `palavras_chave_e_descricao_editadas_tiram_xpkeywords_e_xpsubject_do_exif` (`tests/inspetor.rs`: Salvar, 2º Salvar sem edição, Exportar e Duplicar).
- **Lição:** cada campo editável tem cópias em vários blocos; a lista de cópias a limpar acompanha a lista de campos.

## Posse de documento sem dono e entradas sem teto (auditoria final do backend, P3)
- **Sintoma:** `WindowRegistry::access` dava o documento sem dono à primeira janela que o usasse: entre criar e `claimed`, outra janela (com XSS) podia tomá-lo. `on_second_instance` criava uma thread por mensagem D-Bus; `copy_annotations` decodificava o PNG sem o teto de memória; o `state` de `new_window`/`move_documents` não tinha teto.
- **Correção:** `access` só aceita a dona (só `claim` dá posse); uma thread de trabalho com fila de 16 (`instance::Worker`, excesso descartado com log); `annotations_image` lê as dimensões e passa por `check_budget` antes de alocar; `transfer` recusa `state` acima de 64 MiB (`MAX_STATE`, o mesmo teto das anotações copiadas).
- **Teste:** `documento_sem_dono_nao_e_de_ninguem`, `estado_grande_demais_nao_entra_na_caixa` (`doc/windows.rs`), `pedidos_vao_para_uma_thread_so_com_fila_limitada`, `tetos_de_quantidade_e_tamanho` (agora com caminho que existe) (`commands/instance.rs`), `desenho_das_anotacoes_respeita_o_teto_antes_de_alocar` (`commands/paste.rs`).
## Achados da auditoria final do frontend (rodada 3)

### Pergunta das perdas do Salvar escondida sob o véu "Salvando…"
- **Sintoma:** AVIF/HEIC com XMP (ou JP2/EXR com EXIF), girar, fechar/sair → Salvar: a pergunta das perdas ficava atrás do véu, inalcançável pelo mouse.
- **Causa:** `saveAll` põe o véu (z 1100) e só então `saveDoc` pergunta via `askDiscard`; o `ConfirmDiscard` usava `.file-backdrop` (z 1000).
- **Correção:** `askDiscard` (`src/finder/store.ts`) marca `aboveVeil` quando a janela já está sob o véu: a pergunta é da operação em curso e sobe para a camada das perguntas (`tabs-question`, z 1200). Uma confirmação aberta antes de um véu continua embaixo dele. Escolhida por valer para qualquer pergunta feita sob qualquer véu, sem reordenar o Salvar nem esconder o véu.
- **Teste:** "o aviso de perdas do Salvar fica acima do véu…" e "uma confirmação aberta antes do véu continua embaixo dele" (`src/file/unsaved.test.tsx`, lê os `z-index` dos CSS).
- **Lição:** diálogo pedido por quem pôs o véu precisa estar acima dele.

### Lixo em lote: a pergunta citava só as não salvas
- **Correção:** `trashDocs` (`src/sidebar/trash.ts`) pergunta "Mover N itens…" e lista à parte as não salvas. **Teste:** `src/sidebar/sidebarFiles.test.tsx`.

### Inspetor semeava textos e palavras-chave por documento
- **Sintoma:** num TIFF de 2 páginas, a página 2 mostrava a descrição e as palavras-chave da 1ª página lida.
- **Correção:** originais por página em `textEdits.ts`/`keywords.ts`; a edição continua do documento e vale em todas as páginas (como `render_for_write`); `imageAlt.ts` lê a página exibida. **Teste:** `Inspector.test.tsx` (TIFF de 2 páginas), `textEdits.test.ts`, `src/viewer/imageAlt.test.tsx`.

### Prova de Cor: seletor fora de `lib/dialogs` e perfil órfão
- **Correção:** `proof.ts` usa `src/lib/dialogs`; `setProof` não guarda resposta de documento que saiu da janela. **Teste:** `src/color/proof.test.tsx`.

### Corridas no colar, no recortar e no desfazer por página
- **Correção:** `insertLayer` (`src/select/paste.ts`) captura documento e página antes dos `await` e desiste se mudaram; `cutAnnotations` decide o que apagar antes da cópia e ignora documento que saiu; o desfazer de uma `Op` guarda `frame` e leva a vista a ela (`src/markup/history.ts`). **Teste:** `paste.test.ts`, `clipboard.test.tsx`, `history.test.ts`.
- **Lição:** o que depende da tela se captura antes de qualquer `await`.

### Scanner: opções `null` deixavam o diálogo ocupado
- **Correção:** `ScanDialog.tsx` libera o `busy` também com `null` (opções e dispositivos) e anuncia a leitura das opções (`role="status"`). **Teste:** `src/file/scan.test.tsx`.

## E2E "Exportar para WebP cria o arquivo" falhava no CI desde o Abrir Recente em submenu (rodada 3)
- **Sintoma:** "item de menu não encontrado: Abrir Recente / Open Recent" (mesmo esperando 5 s) e, depois, `invalid session id`.
- **Causa:** b990ba7 pôs `overflow: hidden; text-overflow: ellipsis` no `.menu-label`; com isso o `getText` do WebKitWebDriver devolve `""` para todos os itens (o menu estava aberto e os rótulos no DOM). O `invalid session id` vinha da consulta do `waitUntil` ainda pendente quando a sessão fechou; o app não caiu nem fechou a janela.
- **Correção:** o helper `menuItem` (`e2e/specs/file.e2e.ts`) lê `textContent` e exige o item visível. O Abrir Recente saiu do app; o spec reabre o arquivo por uma segunda execução do binário (instância única), que chega ao `open_documents` como o Abrir.
- **Teste:** o próprio `file.e2e.ts`; o diagnóstico (rótulos vazios pelo `getText`, cheios pelo `innerText`, e o `getText` volta com `overflow: visible`) está em `armadilhas.md`.
- **Lição:** no E2E, não dependa do `getText` para achar elemento por texto: CSS de apresentação muda o resultado.

## Duplicar anotação com coordenada enorme travava a janela (limpeza final)
- **Sintoma:** colar ou duplicar uma anotação em x/y ≈ 1e18 deixava a interface parada.
- **Causa:** o laço que desloca a cópia até não cair em cima de uma igual somava 12 px que se perdiam no arredondamento do `double`: a caixa nunca mudava.
- **Correção:** teto de 1000 voltas (`MAX_OFFSETS`, `src/markup/clipboard.ts`).
- **Teste:** "coordenada enorme (o passo some no arredondamento) não trava" (`src/markup/clipboard.test.tsx`).
- **Lição:** laço que espera uma conta de ponto flutuante mudar algo precisa de teto.

## Lixo: fechar que falha contava como falha de mover; uma imagem só rejeitava sem tratamento (limpeza final)
- **Sintoma:** o arquivo já estava no Lixo, mas o aviso dizia que falhou; pelo menu da miniatura, o erro de uma imagem só virava rejeição solta.
- **Correção:** `trash` (`src/sidebar/trash.ts`) separa o mover do fechar (que só avisa) e `trashDocs` trata o erro de uma imagem só com `notifyError`.
- **Teste:** "já no Lixo mas sem poder fechar…" e "uma imagem só que falha…" (`src/sidebar/sidebarFiles.test.tsx`).

## Testes do Lixo em lote falhavam conforme a ordem e a carga (limpeza final)
- **Sintoma:** "uma falha deixa aquela aberta…" e "com as miniaturas escondidas…" falhavam na suíte (também na base ef438d4) e passavam sozinhos.
- **Causa:** o `flush` esperava 5 ms fixos; o lote cede a vez entre as imagens e continuava no teste seguinte, chamando `moveToTrash` de novo.
- **Correção:** o `flush` de `src/sidebar/sidebarFiles.test.tsx` espera o fim do lote (`useBatch.running`).
- **Lição:** espere a condição, não um prazo.

## Farbfeld e PNM de 16 bits ocupavam 3 vezes a memória estimada (rodada 3, antes de publicar)
- **Sintoma (revisão):** um `.ff` de 16384×16384 passava na conta e chegava a ~3 GiB, acima do teto de decodificação.
- **Causa:** `read_image` e `estimate_bytes` contavam só o RGBA8 final (4 B/px); o buffer de 16 bits fica vivo junto dele.
- **Correção:** `read_image` soma o buffer decodificado (salvo RGBA8/RGB8) e `estimate_bytes` conta 12 B/px para Farbfeld e PNM com `maxval` > 255.
- **Teste:** `dezesseis_bits_contam_a_memoria_de_trabalho` (`tests/formatos.rs`).
- **Lição:** o teto de memória vale para o pico, não para o resultado.

## Apagar e Recortar do menu agiam na imagem com anotação selecionada (rodada 3)
- **Sintoma:** com uma anotação selecionada e uma seleção na imagem, Editar › Apagar ou Recortar apagava pixels da imagem; sem seleção, ficavam desabilitados.
- **Causa:** os comandos de edição só conheciam a seleção da imagem; só a tecla Delete, tratada na camada de Marcação, chegava às anotações.
- **Correção:** `onFocus` (`src/shortcuts/appCommands.ts`) leva Copiar, Recortar, Apagar, Duplicar e Selecionar Tudo às anotações quando há anotação selecionada com a barra visível (`annotationsFocused`); o Recortar só apaga depois de a cópia dar certo.
- **Teste:** "recortar copia e apaga só as copiadas; Apagar do menu apaga a anotação, não a imagem" e "se a cópia falha, o Recortar não apaga nada" (`src/markup/clipboard.test.tsx`).
- **Lição:** um atalho local da camada esconde que o comando do menu faz outra coisa; testar pelo comando, não só pela tecla.

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

## Correções da revisão do Lote 12 (antes de publicar)

### A janela que precisava responder à saída não vinha para a frente
- **Causa:** `setFocus()` no JS é negado pela ACL, e o `catch` vazio escondia o erro.
- **Correção:** `raise` no Rust (mostrar, desminimizar, focar) em `ask` e `close_other_windows`; nenhuma permissão nova.
- **Teste:** "a janela perguntada responde, sem fechar" (`src/tabs/closing.test.ts`) exige que o JS não chame `setFocus`.
- **Lição:** um `catch` vazio em volta de uma API com permissão esconde que ela nunca funcionou.

### Sair ficava preso por uma janela que não respondia ou não terminava de abrir
- **Causa:** a espera da resposta não tinha prazo, a janela não carregada recusava fechar e `confirm_quit` desistia calado.
- **Correção:** ping com prazo antes de perguntar; sem resposta, `confirm_quit` devolve `unresponsive` e a janela que pediu pergunta (padrão Cancelar). Janela que não abriu devolve os documentos a outra ao fechar, ou pergunta pelo sistema se for a única.
- **Teste:** `ping_diz_quem_nao_respondeu`, `janela_que_nao_abriu_fecha_devolvendo_o_que_ia_chegar`, `janela_que_some_antes_da_pergunta_nao_prende_a_saida` (`commands/window.rs`) e "janela que não responde" (`closing.test.ts`).

### Véu apagado por quem não o pôs deixava editável uma janela selada
- **Causa:** um véu só, global; o fim de um mover e o `quit-cancelled` o tiravam, fosse de quem fosse.
- **Correção:** `putVeil` devolve a função que tira só o próprio véu; saída numerada por rodada; selo no Rust com motivo (`Seal`); `seal` espera o movimento em andamento.
- **Teste:** "cada véu cai só pela mão de quem o pôs", "o fim da saída de outra não destrava a janela que está fechando", "com documento mudando de janela, espera terminar antes de selar" e `cancelar_a_saida_nao_solta_quem_esta_fechando_nem_rodada_mais_nova`.

### Edição feita durante uma gravação lenta era dada como respondida ao fechar
- **Causa:** a versão respondida era lida depois de todas as gravações.
- **Correção:** véu durante a gravação e nova conferência até não sobrar documento não salvo; só o descarte explícito vale, na versão em que foi feito.
- **Teste:** "editado durante a gravação lenta de outro: é perguntado de novo".

### Navegar pela pasta roubava o foco e travava num vizinho aberto em outra janela
- **Correção:** `goFolder` e o histórico pulam para o seguinte (`notElsewhere`), sem trazer a outra janela.
- **Teste:** "vizinho aberto em outra janela" (`src/viewer/actions.test.ts`, `history.test.ts`).

### Menores
- Aviso de alteração no disco perdido com o documento mudando de janela: fica pendente até alguém o ter (`mudanca_no_disco_nao_se_perde_com_o_documento_mudando_de_janela`).
- Janela destruída entre o registro da pergunta e o envio prendia a saída (`begin_ask`).
- Mover com o seletor de arquivos do sistema aberto: `src/lib/dialogs.ts`. Juntar recusado avisa quem pediu.
- Fechar durante impressão, PDF ou gravação: espera um pouco e pergunta.
- Permissão `core:window:allow-destroy` retirada (não era usada).
## TIFF de várias páginas (depois do Lote 12)

### Página menor que a primeira fora dos limites; página maior cortada
- **Causa:** `DocStore::pixels()` devolvia o tamanho da página 1 para qualquer quadro, e a interface usava `width`/`height` do documento.
- **Correção:** `Document::size_after_ops(frame)`, `DocInfo::page_sizes`, e na interface `pageSize`/`useShownPage` (`src/lib/pages.ts`, `src/markup/pages.ts`).
- **Teste:** `src-tauri/tests/paginas.rs` e `src/markup/pageSizes.test.ts`.
- **Lição:** fixture de várias páginas precisa ter páginas de tamanhos diferentes.

### Recortar apagava em todas as páginas
- **Causa:** as operações não tinham página.
- **Correção:** `Op::OnPage { frame, op }`, criado só por `DocStore::apply_op_on` (um `OnPage` vindo do IPC é recusado). Toda edição vale para a página exibida, inclusive girar e redimensionar, como no macOS; o perfil de cor é do documento.
- **Teste:** `cortar_vale_so_para_a_pagina_exibida`, `girar_e_redimensionar_valem_so_para_a_pagina_exibida` (`src-tauri/tests/paginas.rs`).

### Gravar um TIFF perdia as outras páginas
- **Correção:** cada página é codificada com os próprios metadados e juntada por `container::TiffJoin` (só pixels e tags são copiados); teto de 2 GB conferido antes de gravar (`too_large`). Os 16 bits e as etiquetas de cada página são lidos do arquivo atual, apontando o cabeçalho para ela.
- **Teste:** `salvar_grava_todas_as_paginas`, `salvar_mantem_16_bits_em_todas_as_paginas`, `salvar_mantem_as_etiquetas_de_cada_pagina` (`src-tauri/tests/paginas.rs`).

### Salvar por cima de um arquivo que virou outra coisa
- **Sintoma:** com a mudança no disco ignorada (ou depois de Reverter), Ctrl+S gravava uma página no formato antigo por cima de um TIFF de várias.
- **Causa:** `save` e `revert` não recalculavam formato, páginas nem `writable`.
- **Correção:** `Document::set_format` no reverter, e o Salvar confere o formato e as páginas do arquivo no disco (`unseen_disk`) antes de gravar.
- **Teste:** `salvar_nao_apaga_paginas_que_apareceram_no_disco`, `salvar_nao_grava_por_cima_de_outro_formato`, `reverter_recalcula_formato_paginas_e_se_da_para_gravar`.

### Salvar Como gravava outra página
- **Causa:** a página era lida depois do diálogo do sistema.
- **Teste:** "grava a página de quando foi pedido" (`src/file/loss.test.tsx`).
- **Lição:** o que depende da tela se captura antes de qualquer `await`.

### Texto apagado continuava nos bytes do EXIF
- **Causa:** `exif_with_dpi` regravava o IFD0 no fim e deixava o antigo (com os textos) como espaço morto, fora do alcance da limpeza.
- **Correção:** só a tabela do IFD0 muda de lugar, os valores ficam onde estão e a tabela antiga é zerada; `exifscrub::scrub` zera também as cópias do valor tirado em áreas mortas (arquivos de versões anteriores).
- **Teste:** `resolucao_nova_nao_deixa_copia_dos_textos_no_exif`, `copia_morta_de_versoes_antigas_tambem_e_apagada` (`src-tauri/tests/inspetor.rs`).
- **Lição:** em metadados, "não aparece no leitor" não é "não está no arquivo": o teste procura nos bytes.

### EXIF acima de 64 KB sumia do JPEG sem aviso
- **Correção:** aviso `exifTooBig` em `metaedit::notes`, com o nome do documento.
- **Teste:** `exif_que_nao_cabe_no_jpeg_avisa` (`src-tauri/tests/inspetor.rs`) e `src/file/loss.test.tsx`.

### TIFF de várias páginas abria só a primeira pelo leitor alternativo (checagem de segurança)
- **Sintoma:** com páginas demais ou uma página que o leitor de páginas não lê (CMYK), o arquivo abria com uma página só, gravável; o Salvar apagaria as outras.
- **Correção:** o leitor de uma página só é usado quando `container::tiff_pages` confirma um IFD só.
- **Teste:** `tiff_com_paginas_demais_nao_abre_como_uma_pagina`, `tiff_de_varias_paginas_nao_cai_no_leitor_de_uma_pagina` (`src-tauri/tests/paginas.rs`).
- **Lição:** um fallback que lê menos do que o principal não pode produzir um documento gravável.

### Limpeza de cópias do EXIF: resíduo, custo e miniatura (checagem de segurança)
- **Sintomas:** cópias sobrepostas de dois valores apagados deixavam um pedaço; bloco forjado com muitas cópias e faixas custava tempo quadrático; a miniatura do IFD1 (a foto de antes das edições) ia para o arquivo.
- **Correção:** cópias procuradas no bloco original e zeradas juntas; faixas protegidas fundidas com busca binária e teto de casamentos (`None` = EXIF descartado); `exif_for_write` tira o IFD1 e zera a miniatura, e `exif_with_dpi` grava 0 como próximo IFD.
- **Teste:** `copias_sobrepostas_de_valores_tirados_somem_inteiras`, `copias_demais_derrubam_o_bloco` (`src-tauri/src/image/exifscrub.rs`), `miniatura_antiga_do_exif_nao_e_gravada` (`src-tauri/tests/inspetor.rs`).

### Colar anotação numa página menor que a primeira (merge com a integração da rodada 3)
- **Sintoma:** anotação copiada que cabia na primeira página, colada numa página menor, ficava fora dela.
- **Causa:** o colar do clipboard de anotações (frente nova) centrava pelo `width`/`height` do documento.
- **Correção:** `insert` (`src/markup/clipboard.ts`) usa `shownSize`; o resto do encontro (seleção arrastável, prévia ao vivo, Copiar anotações, prova de cor) já recebia o tamanho da página.
- **Teste:** "colar numa página menor que a primeira centra a anotação dentro dela" (`src/markup/pageSizes.test.ts`), `src/viewer/pages.test.tsx` e `prova_de_cor_vale_na_pagina_exibida_no_tamanho_dela` (`src-tauri/src/doc/proof.rs`).

### Texto e palavra-chave antigos ficavam nas páginas 2+ de um TIFF (privacidade)
- **Sintoma:** trocar/remover uma palavra-chave ou trocar título, descrição ou autor mudava só a página 1; o valor antigo continuava nos bytes das outras, invisível no Inspetor.
- **Causa:** `render_for_write` (`doc/file.rs`) só levava às páginas 2+ as edições que apagam.
- **Correção:** cada campo editado vale em todas as páginas que o têm (`metadata::page_texts` + `MetadataEdits::split_present`); onde a página não tem o campo, nada é criado e só o resto dele no EXIF sai (`exif_cleared`).
- **Teste:** `edicao_de_texto_e_palavras_chave_vale_em_todas_as_paginas`, `texto_apagado_sai_de_todas_as_paginas` (`src-tauri/tests/paginas.rs`).
- **Lição:** editar num documento de várias páginas é editar todas; o teste procura o valor antigo nos bytes do arquivo inteiro.

### Páginas 2+ de um TIFF com DPI e metadados errados
- **Sintoma:** impressão, PDF e Ajustar Tamanho usavam o DPI da página 1 em todas; com o disco com outro número de páginas, as páginas 2+ perdiam EXIF/XMP/IPTC.
- **Correção:** `Decoded::page_dpi`/`dpi_of`; `SourceFile` casa as páginas por índice até o mínimo.
- **Teste:** `cada_pagina_tem_o_proprio_dpi`, `paginas_do_disco_diferentes_das_do_documento_casam_por_indice` (`src-tauri/tests/paginas.rs`).
