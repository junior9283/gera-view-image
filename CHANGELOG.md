# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- Arquivo › Sair (Ctrl+Q, pergunta pelas alterações não salvas) e Abrir com… no menu Arquivo.
- Setas para cima e para baixo navegam entre as imagens, como na barra lateral do Pré-Visualização.
- Arrastar miniaturas da barra lateral para fora da janela (gerenciador de arquivos, navegador, outro app) entrega o arquivo (validado em X11; Wayland ainda sem teste manual). Com várias miniaturas selecionadas (Ctrl+clique alterna, Shift+clique seleciona o intervalo), arrasta todas. Imagem com alterações não salvas ou sem arquivo (ex.: colada da área de transferência) vai como PNG temporário numa pasta privada do app, apagada ao sair. Anotações ainda não achatadas não entram nesse PNG. Dentro da janela, o arraste continua reordenando.
- Salvar e Exportar em TIFF levam EXIF (IFD0 e sub-IFDs EXIF/GPS), IPTC, XMP, perfil ICC e DPI; o EXIF de um TIFF aberto também aparece no inspetor.
- Salvar e Exportar em BMP levam o perfil ICC (cabeçalho BITMAPV5HEADER).
- Palavras-chave editadas também são gravadas em TIFF (IPTC e XMP). PNG e WebP passam a manter o XMP do original ao salvar.
- JPEG com XMP maior que 64 KB: o XMP estendido (ExtendedXMP, GUID MD5) é lido e gravado.
- Menus com os itens do Pré-Visualização que ainda faltam, por enquanto desabilitados: Fechar Todas, Salvar Como, Mover para o Lixo, Etiquetas, Bloquear, Procurar Todas as Versões, Exportar como PDF, Compartilhar ▸, Importar do Scanner, Localizar ▸, Fala ▸, Ordenar Por ▸, Barra de Ferramentas, Fundo da Imagem, Abas, Voltar/Avançar, Atribuir Perfil, Remover Fundo, Copiar Objeto, Lupa, Cores, Fontes, Inspetor de Marcação, Descrição da Imagem, Texto ao Vivo ▸, janelas e Pesquisar na Ajuda. Os atalhos deles estão reservados e a tabela do README foi regenerada; ela também passa a listar Sair e as setas verticais.
- Texto ao Vivo (OCR local, em português com acentos): selecionar o texto da imagem arrastando, duplo clique seleciona a palavra e triplo seleciona a linha; Ctrl+C e o menu de contexto copiam (o menu também tem Pesquisar, Traduzir e Falar). Há ainda Ferramentas › Texto ao Vivo › Copiar Todo o Texto, Traduzir… e Pesquisar Texto na Web…. O botão Texto ao Vivo no canto destaca o texto e torna clicáveis os links, e-mails, telefones e QR codes detectados. O link lido da imagem é reconstruído no Rust antes de abrir (só `http(s)` com host válido, `mailto:` sem `attach` e `tel:` numérico), e `mailto:`/`tel:` pedem confirmação mostrando o destino. Editar › Localizar (Ctrl+F, Ctrl+G, Ctrl+Shift+G) procura no texto reconhecido sem diferenciar maiúsculas nem acentos, e Editar › Fala lê o texto pelo Speech Dispatcher (`spd-say`). O OCR (PP-OCRv5 no `rten`, Rust puro) roda fora da thread principal, fica em cache por imagem e é cancelado ao trocar de imagem. Os modelos (12,7 MB, Apache-2.0) só são baixados quando você pede, com conferência de SHA-256. Pesquisar Imagem na Web pede confirmação e não envia nada sozinho: copia a imagem e abre o Google Imagens para você colar. Detalhes em `docs/arquitetura/ocr.md`.
- Infraestrutura para os lotes de paridade: comandos planejados por lote, preferências, tipos e comandos IPC (stubs que respondem `unsupported`), slots `title-accessory` e `above-content` e um arquivo de registro por lote. O guia está em `docs/arquitetura/extensao.md`.

### Corrigido
- Imprimir e Duplicar com anotações não salvas não achatam mais o documento aberto: a imagem achatada vai para uma cópia, e as anotações continuam editáveis.
- Esc fecha Ajustar Tamanho mesmo com o foco fora do diálogo.
- Diálogos prendem o foco do teclado (Tab e Shift+Tab), começam no primeiro controle e devolvem o foco ao fechar.
- Atalhos de letra funcionam em layouts de teclado não latinos (cirílico, grego, hebraico) pela tecla física; layouts latinos (ABNT2, AZERTY) continuam pela tecla lógica.
- "Recarregar" na faixa de arquivo alterado pergunta antes de descartar alterações não salvas.
- GIF e WebP animados tocam com a duração de cada quadro do arquivo (atraso de até 10 ms vira 100 ms, como nos navegadores) e respeitam a contagem de repetições declarada (GIF: NETSCAPE2.0; WebP: ANIM). Sem contagem declarada, a animação continua em laço. O `DocInfo` ganhou `delaysMs` e `plays` (mudança aditiva).
- Tamanho Real (100 %) mostra 1 pixel da imagem por pixel físico, compensando a escala da tela (`devicePixelRatio`), e se reajusta quando ela muda (outro monitor, escala do sistema). O indicador continua em 100 %; degraus, limites e Ajustar à Janela (que nunca passa do Tamanho Real) usam o zoom mostrado.
- PNG e TIFF de 16 bits continuam com 16 bits ao salvar: as operações são refeitas em 16 bits sobre o arquivo original (ajustes de cor em ponto flutuante). Exportar em 16 bits de uma origem de 16 bits também usa os 16 bits de verdade.
- `PixelXDimension`/`PixelYDimension` do EXIF passam a refletir o tamanho gravado depois de recortar, girar ou redimensionar.
- JPEG CMYK (ou cinza) com perfil ICC não grava mais o perfil CMYK/cinza num arquivo RGB, o que deixava as cores erradas em outros programas.

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
- AVIF salvo leva só o EXIF: o codificador (ravif/avif-serialize) não grava perfil ICC nem XMP, então as palavras-chave ficam pendentes. JPEG CMYK é regravado em RGB, sem perfil, com a conversão simples do decodificador (sem gestão de cor pelo perfil CMYK).

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
