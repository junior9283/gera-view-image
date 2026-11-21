# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- Arquivo › Sair (Ctrl+Q, pergunta pelas alterações não salvas) e Abrir com… no menu Arquivo.
- Setas para cima e para baixo navegam entre as imagens, como na barra lateral do Pré-Visualização.
- Arrastar miniaturas da barra lateral para fora da janela (gerenciador de arquivos, navegador, outro app) entrega o arquivo (validado em X11; Wayland ainda sem teste manual). Com várias miniaturas selecionadas (Ctrl+clique alterna, Shift+clique seleciona o intervalo), arrasta todas. Imagem com alterações não salvas ou sem arquivo (ex.: colada da área de transferência) vai como PNG temporário numa pasta privada do app, apagada ao sair. Anotações ainda não achatadas não entram nesse PNG. Dentro da janela, o arraste continua reordenando.

### Corrigido
- Imprimir e Duplicar com anotações não salvas não achatam mais o documento aberto: a imagem achatada vai para uma cópia, e as anotações continuam editáveis.
- Esc fecha Ajustar Tamanho mesmo com o foco fora do diálogo.
- Diálogos prendem o foco do teclado (Tab e Shift+Tab), começam no primeiro controle e devolvem o foco ao fechar.
- Atalhos de letra funcionam em layouts de teclado não latinos (cirílico, grego, hebraico) pela tecla física; layouts latinos (ABNT2, AZERTY) continuam pela tecla lógica.
- "Recarregar" na faixa de arquivo alterado pergunta antes de descartar alterações não salvas.
- GIF e WebP animados tocam com a duração de cada quadro do arquivo (atraso de até 10 ms vira 100 ms, como nos navegadores) e respeitam a contagem de repetições declarada (GIF: NETSCAPE2.0; WebP: ANIM). Sem contagem declarada, a animação continua em laço. O `DocInfo` ganhou `delaysMs` e `plays` (mudança aditiva).
- Tamanho Real (100 %) mostra 1 pixel da imagem por pixel físico, compensando a escala da tela (`devicePixelRatio`), e se reajusta quando ela muda (outro monitor, escala do sistema). O indicador continua em 100 %; degraus, limites e Ajustar à Janela (que nunca passa do Tamanho Real) usam o zoom mostrado.

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
- HEIC e JPEG 2000 ainda não podem ser gravados: o codificador HEVC (x265) não pode ir no binário e não há crate JPEG 2000 sem a libopenjp2. HEIC é aberto normalmente (precisa da `libde265`, no Fedora pelo RPM Fusion); Salvar leva a Exportar.
- Salvar em TIFF, BMP e AVIF não leva todos os metadados (EXIF/IPTC/ICC conforme o formato); imagens de 16 bits são salvas em 8 bits; JPEG CMYK é regravado em RGB.

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
