# Lote 7: Barra lateral avançada

Base: `5d148bb` (merge do Lote 1). Commits: `33726f8` (Rust) e `c913405` (TS, i18n, docs).

## O que foi feito
- **Ordenar Por** (`view.sortBy*`, registrados em `src/sidebar/register.ts`): grava `prefs.sortBy`; `sortSync.ts` reordena `docs` ao escolher, ao entrar documento novo e quando a revisão muda. Nome = ordem natural; Tipo = formato e depois nome; Data = mais recente primeiro; Tamanho = maior primeiro; sem arquivo vai ao fim; empate pelo nome. Arrastar uma miniatura volta para "manual". `docs.applyOrder` é o único ponto novo no store.
- **Rust `file_stats`** (`commands/sidebar.rs`): o caminho vem do `DocStore` pelo id (nunca do chamador), leitura em `blocking`, arquivo ausente/diretório/ilegível vira `None`.
- **Multisseleção** (`selection.ts`, store `useThumbSelection`): Ctrl alterna, Shift estende da âncora, setas/Home/End movem, Shift+seta estende, Ctrl+A (foco na barra) seleciona tudo. Seleção vencida (que não contém o ativo) cai para só o ativo.
- **Ações em lote** (`batch.ts`): `applyToTargets` aplica a op em cada imagem com `apply_op` própria (desfazer individual). `runBatch` é sequencial, cede a vez ao navegador entre imagens, mostra progresso na barra, recusa lote simultâneo e continua após falhas; `reportBatch` dá um só aviso com os nomes. Uma imagem só segue o caminho simples antigo (sem trava, erro propagado), para teclas repetidas.
  - Girar/Espelhar: `transform` em `appCommands.ts` usa `batchTargets()`.
  - Ajustar Cor e Ajustar Tamanho: os diálogos aplicam à seleção e mostram a dica "aplica às N imagens". Tamanho: proporcional cabe na caixa escolhida, sem proporção copia o tamanho, `%` (ou sem reamostrar) repete a razão do ativo; o ativo usa exatamente o valor do diálogo.
  - Exportar: `ExportSelectedDialog` abre só com as miniaturas selecionadas marcadas; já nunca sobrescreve (`freeName`); falhas por arquivo agora saem num aviso único no fim (antes cada `notify` se perdia no limite de 3 avisos).
  - Imprimir: `printSelection` ativa cada imagem e chama `printActive` (comando existente), em ordem. A impressão nativa é do Lote 11.
- **Menu de contexto** (`ThumbMenu.tsx`, reaproveita `MenuList` com `ActionItem`): Abrir, Girar, Espelhar, Ajustar Cor/Tamanho, Exportar, Imprimir, Mostrar na Pasta, Mover para o Lixo, Fechar. Em lote, Abrir/Mostrar na Pasta/Lixo ficam desabilitados (Lixo nunca em lote); Fechar passa pelo diálogo de não salvo (`closeDocs`).

## Integrações fora dos arquivos exclusivos (mínimas)
`src/shortcuts/appCommands.ts` (`transform`), `src/adjust/AdjustColorPanel.tsx` e `ResizeDialog.tsx` (aplicar à seleção), `src/file/ExportDialog.tsx` (seleção inicial e aviso de falhas; arquivo do Lote 11, só `ExportSelectedDialog`), `src/i18n/*.json` (chaves `sidebar.*`, `adjust.batchHint`, `resize.batchHint`), `docs/arquitetura/extensao.md`, CHANGELOG (só `[Não lançado]`).

## TDD
Testes escritos junto/antes da implementação em `selection.test.ts`, `sort.test.ts`, `batch.test.ts`, `sortSync.test.ts`, `sidebar.test.tsx` e `docs.test.ts` (applyOrder). Não os vi falhar antes por rodá-los só depois de escrever o código: provei por mutação (falha engolida em `runBatch` virou `throw` e a ordem de Data/Tamanho foi invertida: 3 testes falharam; revertido, todos passam). O teste de regressão do `appCommands` (girar duas vezes seguidas) pegou a trava de lote em uma imagem só e levou ao caminho simples para 1 imagem.

## Não verificado
- Interação real no app (arraste, foco por teclado, posição do menu) só em jsdom; sem teste E2E nem execução visual.
- Imprimir em lote com impressão real: a janela de impressão pode não aceitar jobs em sequência rápida (depende do Lote 11).
- Menu Ordenar Por não mostra marca no critério ativo (o `MenuList` não tem itens marcáveis).
- Mover para o Lixo e Mostrar na Pasta só para uma imagem (decisão de segurança).
