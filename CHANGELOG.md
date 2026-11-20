# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- Menu Arquivo: Salvar (gravação atômica, preserva EXIF/IPTC/ICC e zera a orientação após girar), Exportar e Exportar Selecionadas (JPEG, PNG, TIFF, WebP, AVIF, OpenEXR, BMP, com tamanho estimado), Duplicar, Renomear, Mover Para, Mostrar na Pasta, Abrir com, Reverter (Última Versão Salva / Original), Abrir Recentes, Imprimir, Capturar Tela e Novo da Área de Transferência.
- Pergunta antes de fechar imagens com alterações e aviso quando o arquivo muda ou é apagado fora do app.

### Limitações conhecidas
- HEIC e JPEG 2000 ainda não podem ser gravados: o codificador HEVC (x265) não pode ir no binário e não há crate JPEG 2000 sem a libopenjp2. HEIC é aberto normalmente; Salvar leva a Exportar.

## [0.1.2] - 2026-11-20

### Corrigido
- Janela em branco em sessões Wayland com janela transparente (modo compositing do WebKitGTK desativado por padrão).

### Alterado
- Tags de release anotadas.

## [0.1.1] - 2026-11-20

### Adicionado
- Teste do atualizador.

## [0.1.0] - 2026-11-20

### Adicionado
- Esqueleto do aplicativo (Tauri 2).
- Barra de título que segue o tema do sistema.
- Logo do aplicativo.
- Pacotes .deb, .rpm e AppImage.
- Pipeline de versão (`npm run release <versão>`), CI e release automático no GitHub Actions.
- Atualização automática assinada (deb, rpm e AppImage) com diálogo de novidades.
