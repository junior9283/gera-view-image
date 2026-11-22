# Changelog

Todas as mudanças relevantes deste projeto são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- Barra lateral avançada (Lote 7): Visualizar › Ordenar Por (Nome, Data, Tipo, Tamanho). Nome usa ordem natural (img2 antes de img10) e Tipo agrupa pelo formato; Data põe o mais recente primeiro e Tamanho o maior primeiro (o Rust lê data e tamanho do arquivo do documento, nunca de um caminho recebido); itens sem arquivo vão ao fim. A ordem acompanha as imagens novas e arrastar uma miniatura volta para a ordem manual. Seleção múltipla: Ctrl+clique alterna, Shift+clique seleciona o intervalo, setas/Home/End movem e Shift+seta estende, Ctrl+A (com o foco na barra) seleciona todas. Girar e Espelhar, Ajustar Cor e Ajustar Tamanho passam a valer para todas as miniaturas selecionadas, cada imagem com o próprio desfazer (no Ajustar Tamanho, a proporção cabe no tamanho escolhido e a unidade % repete a razão). Uma falha numa imagem não interrompe as outras: um só aviso lista quais falharam, e a barra mostra o progresso sem travar a interface. Exportar Selecionadas já abre só com as miniaturas selecionadas marcadas e nunca sobrescreve (cria "nome (1)"), relatando as falhas por arquivo no fim. Botão direito na miniatura: Abrir, Girar, Espelhar, Ajustar Cor/Tamanho, Exportar, Imprimir, Mostrar na Pasta, Mover para o Lixo e Fechar. Imprimir em lote só entrega cada imagem, em ordem, ao comando de impressão atual; a impressão nativa é de outro lote.
- Marcação extra (Lote 10): painel Cores (Ctrl+Shift+C ou botão da barra) com cor da borda, do preenchimento e do texto, opacidade, conta-gotas e cores recentes (guardadas nas preferências). O conta-gotas lê o pixel exibido na imagem (cor de tela, a mesma em que as anotações são desenhadas e que o núcleo leva ao perfil do documento ao achatar), porque o `EyeDropper` do navegador não existe no WebKitGTK. Painel Fontes (Ctrl+T) com todas as famílias instaladas, busca, tamanho e estilo; a lista é lida por `fontdb` fora da thread principal (GTK) e o nome da família vai entre aspas no desenho. A barra de Marcação ganhou os botões Ajustar Cor, Ajustar Tamanho e Descrição da Imagem (este chama o comando do Inspetor e fica desabilitado enquanto ele não existir) e o Inspetor de Marcação: posição, tamanho, texto, espessura, tracejado, sombra e opacidade da anotação selecionada.
- Assinatura pela câmera: nova aba Câmera, que só liga depois de um clique e de uma confirmação, mostra o indicador "Câmera ligada", desliga ao capturar, trocar de aba, fechar o painel ou esconder a janela e não grava nada além da assinatura (tinta preta sobre fundo transparente, com limiar de Otsu ajustável). No Rust, um handler do sinal `permission-request` do WebKitGTK, instalado na inicialização do app, é a única barreira: o consentimento é de uso único e vale 20 s, só pedido de vídeo de câmera é liberado (áudio, captura de tela e qualquer outra permissão são negados) e a propriedade `enable-media-stream` do WebKit não é alterada. Sem câmera, sem permissão, webcam desconectada ou sem suporte de mídia, o painel mostra o erro.

## [0.4.1] - 2026-11-22

### Corrigido
- A janela sumia ao abrir uma imagem ou um menu e só a última região clicada ficava visível (WebKitGTK recente). O desenho acelerado volta a ser o padrão, com um ajuste para a Nvidia que evitou o fechamento com "Error 71" na placa testada. `GVI_GPU_ACCEL` deixou de existir; se a tela falhar com a sua placa, abra com `GVI_SAFE_RENDER=1`.

## [0.4.0] - 2026-11-22

### Adicionado
- Ferramentas › Remover Fundo (Ctrl+Shift+K) e Copiar Objeto (também no menu de contexto da imagem): um modelo de IA local (U²-Netp, Apache-2.0, rodando em Rust puro com `tract`) encontra o sujeito principal. Remover Fundo deixa o resto transparente numa só operação, que se desfaz com Ctrl+Z; Copiar Objeto seleciona o sujeito e o copia com fundo transparente. O modelo (4,4 MB) não vai no pacote: no primeiro uso o app pede permissão, baixa-o uma vez do GitHub para a pasta de dados do app e só o aceita com o SHA-256 fixo. O processamento roda fora da thread principal e pode ser cancelado; nenhuma imagem sai do computador. A borda do recorte é binária (sem alfa parcial) e a qualidade é a do U²-Netp, abaixo da do macOS em cabelo e objetos finos.
- Texto ao Vivo (OCR local, em português com acentos): selecionar o texto da imagem arrastando, duplo clique seleciona a palavra e triplo seleciona a linha; Ctrl+C e o menu de contexto copiam (o menu também tem Pesquisar, Traduzir e Falar). Há ainda Ferramentas › Texto ao Vivo › Copiar Todo o Texto, Traduzir… e Pesquisar Texto na Web…. O botão Texto ao Vivo no canto destaca o texto e torna clicáveis os links, e-mails, telefones e QR codes detectados. O link lido da imagem é reconstruído no Rust antes de abrir (só `http(s)` com host válido, `mailto:` sem `attach` e `tel:` numérico), e `mailto:`/`tel:` pedem confirmação mostrando o destino. Editar › Localizar (Ctrl+F, Ctrl+G, Ctrl+Shift+G) procura no texto reconhecido sem diferenciar maiúsculas nem acentos, e Editar › Fala lê o texto pelo Speech Dispatcher (`spd-say`). O OCR (PP-OCRv5 no `rten`, Rust puro) roda fora da thread principal, fica em cache por imagem e é cancelado ao trocar de imagem. Os modelos (12,7 MB, Apache-2.0) só são baixados quando você pede, com conferência de SHA-256. Pesquisar Imagem na Web pede confirmação e não envia nada sozinho: copia a imagem e abre o Google Imagens para você colar. Detalhes em `docs/arquitetura/ocr.md`.
- Correspondência de cor na exibição: imagens com perfil ICC (Display P3, Adobe RGB, ProPhoto, Rec. 2020 e outros RGB v2/v4) aparecem com as cores certas na visualização, nas miniaturas e na prévia de Ajustar Cor. A conversão usa a `moxcms` (Rust puro, nada novo no NEEDED), só na resolução de tela e com transforms em cache; o sRGB embutido é reconhecido como identidade e não custa nada. O destino é sRGB. Numa sessão X11 com perfil de monitor no colord, o destino passa a ser esse perfil; no Wayland, a correção do monitor fica com o compositor. Anotações e a Lupa, desenhadas em cores de tela, são levadas ao perfil do documento ao achatar. Copiar, o PNG temporário do arraste e a impressão saem em sRGB, e Colar trata a área de transferência como sRGB. Preferências › "Correspondência de cor" desliga a conversão.
- Ferramentas › Atribuir Perfil…: reinterpreta a imagem com sRGB, Display P3, Adobe RGB (1998), ProPhoto RGB, Rec. 2020 ou um perfil RGB instalado em `/usr/share/color/icc`, `~/.local/share/icc` ou `~/.color/icc`. Os pixels não mudam, a operação se desfaz com Ctrl+Z, e Salvar/Exportar gravam o perfil atribuído.
- Exportar › "Perfil de cor": manter o da imagem (padrão), ou converter para sRGB, Display P3 ou Adobe RGB (1998), em 8 ou 16 bits. O perfil escolhido é embutido mesmo com "Remover metadados". AVIF e EXR, que não levam ICC, e "Remover metadados" sem perfil escolhido gravam em sRGB, para as cores saírem certas.
- Visualizar extras (Lote 8): Ferramentas › Mostrar Lupa (tecla `` ` ``; no ABNT2, Shift+´) abre uma lente redonda que segue o ponteiro e amplia 3× a imagem sob ele, pedindo ao núcleo a região em resolução maior que a da tela. Visualizar › Mostrar Fundo da Imagem liga e desliga o xadrez atrás da transparência (também na lupa). Ir › Voltar/Avançar (Ctrl+[ / Ctrl+]) andam pelo histórico de documentos e páginas visitados, pulando os fechados; navegando pela pasta com um só documento aberto, Voltar reabre o arquivo anterior. Arquivo › Fechar Todas (Ctrl+Alt+W) fecha tudo, perguntando antes pelas alterações não salvas.
- Editar › Colar (Ctrl+V) cola a imagem da área de transferência como camada flutuante na imagem aberta, em tamanho real (reduzida só se não couber) no centro da área visível e já selecionada: move e redimensiona com a ferramenta Selecionar da Marcação e é achatada ao salvar. Sem imagem aberta, Colar continua criando um documento novo.
- Soltar um arquivo de imagem sobre a imagem aberta cola esse arquivo como camada no ponto do drop. Vários arquivos, ou o drop fora da imagem, continuam abrindo como documentos.
- Copiar (Ctrl+C) sem seleção copia a imagem inteira, como no Pré-Visualização. Com anotações ainda não achatadas, a cópia (da seleção ou da imagem) sai como aparece na tela, com elas compostas por cima.
- Tamanho da seleção retangular ou elíptica (largura × altura em px) aparece ao lado do canto durante o arraste.
- Menu de contexto na imagem (botão direito): Recortar, Copiar, Colar, Copiar Objeto, Copiar Todo o Texto, Girar à Esquerda/Direita, Compartilhar ▸ e Abrir com…. Os itens de lotes que ainda não chegaram aparecem desabilitados.
- Visualizar › Personalizar Barra de Ferramentas…: arraste itens da paleta para a barra (e para fora, para tirar), arraste o conjunto padrão para restaurar e escolha Ícone, Ícone e Texto ou Somente Texto. Pelo teclado, clique acrescenta, Delete tira e Ctrl+←/→ move. Itens opcionais: Recortar, Ajustar Cor, Ajustar Tamanho, Alfa Instantâneo, Espelhar, Tamanho Real, Ajustar à Janela, Apresentação, Exportar e Imprimir. A escolha fica nas preferências.
- Visualizar › Ocultar Barra de Ferramentas (Ctrl+Shift+T).
- Arquivo › Compartilhar ▸ e o botão Compartilhar: E-mail… abre o cliente de e-mail com a imagem anexada (portal `org.freedesktop.portal.Email`; sem portal, `xdg-email --attach`). KDE Connect… aparece quando o `kdeconnect-cli` está instalado: com um aparelho, envia direto; com vários, pergunta qual. O botão também tem Copiar, Exportar e Abrir com ▸, que lista os apps que abrem o tipo do arquivo (padrão do sistema primeiro) e mantém "Outro…" com o seletor do sistema.
- Ajuda › Pesquisar (Ctrl+?): o menu Ajuda abre com um campo de busca que acha qualquer item de menu pelo nome, sem diferenciar acentos, e mostra onde ele fica. Enter executa o primeiro resultado.
- Popover do título: o botão ao lado do nome do arquivo mostra e edita o nome, as etiquetas, o local (Mover Para…, Mostrar na pasta) e o Bloqueado.
- Arquivo › Etiquetas…: as etiquetas ficam no atributo estendido `user.xdg.tags` (UTF-8, separadas por vírgula), o mesmo do Dolphin/Baloo, e aparecem lá. O Nautilus não mostra etiquetas. Sistema de arquivos sem atributos de usuário (FAT, alguns de rede) avisa em vez de gravar.
- Arquivo › Bloquear: tira a permissão de escrita do arquivo (`chmod a-w`), e o Salvar passa a ir para Exportar; desbloquear devolve a escrita ao dono.
- Arquivo › Mover para o Lixo (Ctrl+Backspace): usa o portal `org.freedesktop.portal.Trash` e, sem portal, a especificação freedesktop Trash (crate `trash`). Nunca apaga o arquivo: se não houver Lixo, mostra o erro e o arquivo fica onde está. Com alterações não salvas, pergunta antes. Um link simbólico vai para o Lixo como link, e o alvo fica.
- Arquivo › Salvar Como… (Ctrl+Shift+Alt+S): grava em outro arquivo (JPEG, PNG, TIFF, WebP, AVIF ou BMP, pela extensão), que passa a ser o documento.
- Reverter Para › Procurar Todas as Versões…: cada Salvar guarda antes a versão anterior do arquivo numa pasta privada do app (`~/.local/share/gera-view-image/versions`, 0700, arquivos 0600), até 500 MB no total (`versionsMaxMb`; as mais antigas saem primeiro). O navegador mostra a versão atual ao lado da escolhida, e Restaurar troca o conteúdo do documento sem gravar: o arquivo só muda no próximo Salvar. As versões são do caminho do arquivo e não acompanham Renomear/Mover.

### Corrigido
- Salvar (e Exportar por cima de um arquivo) não apaga mais os atributos estendidos `user.*` do arquivo, como etiquetas, comentário e nota do Dolphin. A gravação atômica cria um arquivo novo, e agora eles são copiados para ele.

### Limitações conhecidas (o que falta para a 1.0)
- AVIF salvo leva só o EXIF: o codificador (ravif/avif-serialize) não grava perfil ICC nem XMP, então as palavras-chave ficam pendentes; as cores são convertidas para sRGB. JPEG CMYK é regravado em RGB, sem perfil, com a conversão simples do decodificador (sem gestão de cor pelo perfil CMYK).

## [0.3.0] - 2026-11-21

### Adicionado
- Gravar HEIC e JPEG 2000 (Salvar e Exportar), com qualidade ajustável e transparência. HEIC leva EXIF e perfil ICC e usa o codificador HEVC kvazaar, carregado só se a `libkvazaar` estiver instalada (como a `libde265` para abrir; os pacotes a recomendam): sem ela, HEIC some do Exportar e o Salvar explica o que instalar. JPEG 2000 usa o `openjp2` (Rust puro), sem perdas por padrão ao salvar, e leva o perfil ICC (o formato não tem lugar padrão para EXIF). A qualidade do JPEG 2000 é uma taxa de compressão: em imagens muito simples (gráficos, cores chapadas) o arquivo com perdas pode sair maior que o sem perdas; nesses casos use "Sem perdas".
- Abrir JPEG 2000 (`.jp2`).
- Avisos de licença de terceiros (`THIRD_PARTY_LICENSES`) nos pacotes e link em Ajuda › Sobre.
- Arquivo › Sair (Ctrl+Q, pergunta pelas alterações não salvas) e Abrir com… no menu Arquivo.
- Setas para cima e para baixo navegam entre as imagens, como na barra lateral do Pré-Visualização.
- Arrastar miniaturas da barra lateral para fora da janela (gerenciador de arquivos, navegador, outro app) entrega o arquivo (validado em X11; Wayland ainda sem teste manual). Com várias miniaturas selecionadas (Ctrl+clique alterna, Shift+clique seleciona o intervalo), arrasta todas. Imagem com alterações não salvas ou sem arquivo (ex.: colada da área de transferência) vai como PNG temporário numa pasta privada do app, apagada ao sair. Anotações ainda não achatadas não entram nesse PNG. Dentro da janela, o arraste continua reordenando.
- Salvar e Exportar em TIFF levam EXIF (IFD0 e sub-IFDs EXIF/GPS), IPTC, XMP, perfil ICC e DPI; o EXIF de um TIFF aberto também aparece no inspetor.
- Salvar e Exportar em BMP levam o perfil ICC (cabeçalho BITMAPV5HEADER).
- Palavras-chave editadas também são gravadas em TIFF (IPTC e XMP). PNG e WebP passam a manter o XMP do original ao salvar.
- JPEG com XMP maior que 64 KB: o XMP estendido (ExtendedXMP, GUID MD5) é lido e gravado.
- Menus com os itens do Pré-Visualização que ainda faltam, por enquanto desabilitados: Fechar Todas, Salvar Como, Mover para o Lixo, Etiquetas, Bloquear, Procurar Todas as Versões, Exportar como PDF, Compartilhar ▸, Importar do Scanner, Localizar ▸, Fala ▸, Ordenar Por ▸, Barra de Ferramentas, Fundo da Imagem, Abas, Voltar/Avançar, Atribuir Perfil, Remover Fundo, Copiar Objeto, Lupa, Cores, Fontes, Inspetor de Marcação, Descrição da Imagem, Texto ao Vivo ▸, janelas e Pesquisar na Ajuda. Os atalhos deles estão reservados e a tabela do README foi regenerada; ela também passa a listar Sair e as setas verticais.
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
- Salvar HEIC regrava com perdas (qualidade 80) e não leva XMP/palavras-chave, imagens auxiliares (mapa de profundidade, ganho HDR) nem o perfil nclx (ex.: Display P3 sem ICC vira sRGB). JPEG 2000 de 12/16 bits é salvo em 8 bits.
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
