# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- Gravar HEIC e JPEG 2000 (Salvar e Exportar), com qualidade ajustável e transparência. HEIC leva EXIF e perfil ICC e usa o codificador HEVC kvazaar, carregado só se a `libkvazaar` estiver instalada (como a `libde265` para abrir; os pacotes a recomendam): sem ela, HEIC some do Exportar e o Salvar explica o que instalar. JPEG 2000 usa o `openjp2` (Rust puro), sem perdas por padrão ao salvar, e leva o perfil ICC (o formato não tem lugar padrão para EXIF). A qualidade do JPEG 2000 é uma taxa de compressão: em imagens muito simples (gráficos, cores chapadas) o arquivo com perdas pode sair maior que o sem perdas; nesses casos use "Sem perdas".
- Abrir JPEG 2000 (`.jp2`).
- Avisos de licença de terceiros (`THIRD_PARTY_LICENSES`) nos pacotes e link em Ajuda › Sobre.

## [0.2.1] - 2026-11-21

### Corrigido
- O app não trava mais ao abrir em sistemas onde o portal do desktop (xdg-desktop-portal) não responde: a consulta do tema saiu da thread principal e ganhou tempo limite de 2 s.

## [0.2.0] - 2026-11-20

### Adicionado
- Núcleo de imagem em Rust: abre JPEG, PNG, GIF animado, BMP, TIFF com várias páginas, WebP, HEIC/HEIF, AVIF, ICO, SVG, PSD (achatado), TGA e RAW (DNG, CR2/CR3, NEF, ARW, ORF, RW2, pela prévia embutida). Imagens enormes abrem por uma prévia reduzida, respeitam a orientação EXIF e ficam sob orçamento de memória; arquivo corrompido mostra erro só nele.
- Visualizador: barra lateral com miniaturas, folha de contatos e reordenação por arraste; navegação pela pasta; Tamanho Real, Ajustar à Janela, zoom com roda e pinça, pan, Tela Cheia e Apresentação; fundo configurável com xadrez para transparência.
- Barra de título que segue o tema e o layout de botões do sistema (KDE, GNOME, elementary), barra de menus completa (Alt/F10), barra de ferramentas e atalhos do Pré-Visualização com Ctrl.
- Seleção retangular, elíptica, laço, laço inteligente e Alfa Instantâneo; copiar, recortar, apagar, inverter e recortar a imagem pela seleção.
- Girar, espelhar, Ajustar Cor (histograma, níveis, ajuste automático, exposição, contraste, realces, sombras, saturação, temperatura, matiz, sépia e nitidez) e Ajustar Tamanho (unidades, ppp, proporção, reamostragem, presets).
- Marcação: esboço com reconhecimento de forma, desenho livre, linha, seta, retângulo (também arredondado), oval, balão, estrela, polígono, lupa, realce, texto com estilo e assinaturas (desenhadas ou importadas), editáveis até salvar.
- Inspetor: geral, EXIF, IPTC, GPS com link para o mapa, palavras-chave editáveis e lista de anotações.
- Menu Arquivo: Salvar (gravação atômica, preserva EXIF/IPTC/ICC e zera a orientação após girar), Exportar e Exportar Selecionadas (JPEG, PNG, TIFF, WebP, AVIF, OpenEXR, BMP, com tamanho estimado), Duplicar, Renomear, Mover Para, Mostrar na Pasta, Abrir com, Reverter (Última Versão Salva / Original), Abrir Recentes, Imprimir, Capturar Tela e Novo da Área de Transferência.
- Pergunta antes de fechar imagens com alterações e aviso quando o arquivo muda ou é apagado fora do app.
- Preferências (fundo, abertura, navegação na pasta, atualização automática, decoração nativa, idioma), janela Sobre e interface em pt-BR e inglês.
- README com prints, E2E (WebdriverIO + tauri-driver sob Xvfb) no CI e prints gerados por `scripts/screenshots.mjs` com imagens sintéticas.

### Limitações conhecidas (o que falta para a 1.0)
- Arrastar uma miniatura para fora da janela (para outro app) ainda não existe; a barra lateral só reordena.
- GIF animado toca com 100 ms fixos por quadro (a duração de cada quadro do arquivo é ignorada).
- Salvar em TIFF, BMP e AVIF não leva todos os metadados (EXIF/IPTC/ICC conforme o formato); imagens de 16 bits são salvas em 8 bits; JPEG CMYK é regravado em RGB.
- Imprimir e Duplicar com anotações não salvas achatam as anotações no documento aberto.
- Tamanho Real usa 1 pixel da imagem por pixel CSS (sem compensar a escala da tela).
- Atalhos de letra não funcionam em layouts de teclado não latinos (ex.: cirílico).
- Foco do teclado não fica preso dentro de alguns diálogos (acessibilidade).

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
