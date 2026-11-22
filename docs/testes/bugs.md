# Registro de bugs

Formato: sintoma, causa, correção, teste, lição.

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
