# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

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
