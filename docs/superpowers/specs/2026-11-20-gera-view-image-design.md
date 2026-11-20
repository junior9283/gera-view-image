# Gera View Image — Design

Data: 2026-11-20 · Status: rascunho para aprovação

## 1. Intenção

Um visualizador e editor leve de **imagens** para Linux que reproduz a experiência do
**Pré-Visualização (Preview) do macOS**: mesmo layout, mesmos fluxos, mesmas ferramentas e
atalhos equivalentes (Cmd → Ctrl). Ele é distribuído como `.deb`, `.rpm` e `.AppImage`, com
versões numeradas e atualização automática a partir dos releases oficiais no GitHub.

Por quê: no Linux não existe um app que junte, num só lugar e com a fluidez do Preview,
visualização rápida, marcação, ajustes de cor/tamanho e exportação.

## 2. Objetivos

- Abrir imagens instantaneamente (duplo clique no gerenciador de arquivos) e navegar pela pasta.
- Ter todas as funções **de imagem** do Preview (lista na §5).
- Visual no estilo macOS com **identidade própria** (logo, nome e ícones originais).
- Pacotes `.deb`, `.rpm` e `.AppImage` (x86_64) gerados no CI a cada tag de versão.
- Atualização automática assinada, para os três formatos.
- Repositório público `github.com/junior9283/gera-view-image` com README em pt-BR, prints reais
  do app e explicação de cada função.

## 3. Não-objetivos

- **PDF** (decisão do usuário: só imagens).
- Integrações exclusivas da Apple: iCloud, AirDrop, Continuidade (câmera/esboço do iPhone),
  importação de iPhone/scanner, navegador de versões estilo Time Machine.
- Texto ao Vivo (OCR) e Pesquisa Visual. *(Minha decisão: dependem de OCR/IA pesados e ficam para
  uma versão futura.)*
- Builds para ARM, Windows e macOS na v1.

## 4. Anti-objetivos (seria fracasso mesmo funcionando)

- Copiar assets da Apple (ícones SF Symbols, fonte SF, logo ou nome "Preview").
- Abrir devagar ou pesar como um editor (meta: janela com imagem em < 400 ms num SSD).
- Janela branca ou quebrada com Nvidia/Wayland (é a máquina do usuário: Intel + GTX 1650 híbrida, Wayland).
- Alterar o arquivo original sem o usuário salvar (ver §5.9).
- Atualização que instala sem verificar a assinatura.

## 5. Funcionalidades (paridade com o Preview, só imagens)

### 5.1 Abrir e navegar
- Abrir um ou vários arquivos (diálogo, arrastar e soltar, argumento de linha de comando, "Abrir com").
- Registro como app padrão de imagem (MIME types no `.desktop`).
- Barra lateral: **Miniaturas**, **Folha de contatos** (grade) e oculta. Reordenar e arrastar para fora.
- Navegação ←/→ entre os arquivos abertos e, *(minha decisão)*, entre as imagens da mesma pasta
  quando só um arquivo foi aberto.
- TIFF com várias páginas e GIF animado: os quadros aparecem como páginas na barra lateral (GIF também anima).
- Novo a partir da área de transferência (Ctrl+N).
- Capturar tela (Arquivo ▸ Capturar Tela: seleção, janela, tela inteira) via xdg-desktop-portal, que funciona no Wayland.
- Arquivos recentes.

### 5.2 Formatos
- Abrir: JPEG, PNG, GIF, BMP, TIFF, WebP, HEIC/HEIF, AVIF, ICO, SVG (rasterizado), PSD (achatado),
  TGA, RAW comuns (DNG, CR2/CR3, NEF, ARW, ORF, RW2) como prévia revelada.
- Exportar: JPEG, PNG, TIFF, HEIC, WebP, AVIF, JPEG 2000, OpenEXR, BMP. Controles de qualidade,
  profundidade e alfa, com **estimativa do tamanho final** como no Preview.

### 5.3 Visualizar
- Tamanho Real (Ctrl+0), Ajustar à Janela (Ctrl+9), Ampliar/Reduzir (Ctrl+= / Ctrl+-),
  Ampliar Seleção (Ctrl+*), zoom com Ctrl+roda e pinça do touchpad, arrastar para mover (pan).
- Tela cheia (F11 / Ctrl+Ctrl+F) e Apresentação de Slides (Ctrl+Shift+F) com controles e transição.
- Tema claro/escuro seguindo o sistema.
- Fundo da área de imagem configurável e xadrez para transparência.

### 5.4 Transformar
- Girar à esquerda/direita (Ctrl+L / Ctrl+R) e espelhar horizontal/vertical.
- Recortar (Ctrl+K) a partir da seleção.
- Ajustar Tamanho: largura/altura em px, %, cm, mm, pol; resolução (ppp); "Redimensionar proporcionalmente";
  "Reamostrar imagem"; presets; tamanho resultante em tempo real.

### 5.5 Seleção
- Retangular, Elíptica, Laço, Laço Inteligente e **Alfa Instantâneo** (arrastar sobre uma cor para
  torná-la transparente, com tolerância controlada pelo arrasto).
- Copiar, recortar, colar, apagar a seleção, inverter a seleção e selecionar tudo.

### 5.6 Marcação (barra de Marcação, Ctrl+Shift+A)
- Esboço (com reconhecimento de forma) e Desenho livre.
- Formas: linha, seta, retângulo, retângulo arredondado, oval, balão de fala, estrela, polígono,
  **Lupa** (ampliação) e **Realce** (escurece o restante).
- Texto com estilo (fonte, tamanho, cor, negrito/itálico/sublinhado, alinhamento).
- **Assinatura**: desenhar com mouse/touchpad ou importar a imagem de uma assinatura. As assinaturas
  ficam salvas para reutilizar.
- Estilos: espessura e tipo da linha, pontas de seta, sombra, cor da borda, cor de preenchimento.
- Anotações continuam editáveis (mover, redimensionar, mudar estilo) até salvar. Depois são achatadas na imagem.

### 5.7 Ajustar Cor (Ctrl+Alt+C)
- Histograma com Níveis (preto, meio-tom, branco), **Ajuste Automático**, Exposição, Contraste,
  Realces, Sombras, Saturação, Temperatura, Matiz (tint), Sépia, Nitidez e "Redefinir Tudo".
- Pré-visualização ao vivo. O processamento final roda no Rust.

### 5.8 Inspetor (Ctrl+I)
- Abas: Geral (dimensões, ppp, modelo de cor, perfil, profundidade, tamanho do arquivo, datas),
  EXIF, IPTC, GPS (coordenadas + link para abrir no mapa), TIFF/PNG específicos, Palavras-chave,
  Anotações (lista).

### 5.9 Arquivo
- Salvar (Ctrl+S), Duplicar (Ctrl+Shift+S), Renomear, Mover para…, Exportar…, Exportar Selecionadas…
  (lote com formato/tamanho), Reverter para o Último Salvo / Original, Imprimir (Ctrl+P),
  Abrir com outro app, Mostrar na pasta.
- Desfazer/Refazer ilimitado na sessão (Ctrl+Z / Ctrl+Shift+Z).
- Nada é gravado sem Salvar. *(Minha decisão: o Preview salva automaticamente, mas aqui o
  salvamento é explícito para não arriscar o original. Ao fechar com alterações, o app pergunta.)*

### 5.10 Ajustes do app
- Preferências: geral (fundo, comportamento ao abrir, navegação na pasta), atualizações
  (verificar automaticamente: sim/não), assinaturas, idioma.
- Idiomas: **pt-BR e inglês**, escolhido pelo idioma do sistema *(minha decisão)*.

## 6. Visual

- Janela sem a decoração do sistema, com **barra de título unificada no estilo macOS**: três botões
  coloridos à esquerda (fechar/minimizar/maximizar), nome do arquivo ao centro e a barra de ferramentas
  do Preview à direita (barra lateral, zoom, compartilhar/exportar, marcação, girar, buscar/inspetor).
  Os botões e ícones são desenhados para o projeto.
- *(Minha decisão)*: o Linux não tem barra de menus global como o macOS, então o menu
  (Arquivo, Editar, Visualizar, Ir, Ferramentas, Janela, Ajuda) fica numa linha compacta dentro
  da barra de título. Há uma preferência para usar a decoração nativa do sistema.
- Fonte: Inter (licença livre), com espaçamento, raios, sombras, translucidez e animações discretas
  à moda do macOS.
- Logo original em SVG, exportado para todos os tamanhos de ícone (16–512 px).

## 7. Arquitetura (decidida: Tauri 2)

- **Tauri 2**: backend em **Rust**, interface em **React + TypeScript + Vite**.
- Rust: decodificação/codificação (crate `image` + `libheif`, `ravif`/`rav1e`, `rawler` para RAW,
  `psd`, `resvg`), metadados (`kamadak-exif`, IPTC), filtros de cor e redimensionamento
  (`fast_image_resize`), Alfa Instantâneo e cache de miniaturas. A interface recebe
  prévias em resolução de tela e as operações finais rodam sobre a imagem inteira no Rust.
- Interface: canvas 2D para exibição e a camada de anotações (modelo vetorial próprio, serializável
  para desfazer/refazer).
- **Mitigação WebKitGTK/Nvidia**: na inicialização, `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  (e fallback de compositing quando necessário). É a **primeira validação** do projeto,
  feita na máquina do usuário antes de qualquer outra funcionalidade.
- Os escolhidos de dependências exatas e a estrutura interna dos módulos ficam com o construtor.

## 8. Versionamento e releases

- **SemVer** (`MAJOR.MINOR.PATCH`), começando em `0.1.0`. A `1.0.0` sai quando a paridade da §5 estiver completa.
- A versão tem uma única fonte: um script `npm run release <versão>` sincroniza `package.json`,
  `tauri.conf.json` e `Cargo.toml`, atualiza o `CHANGELOG.md` (Keep a Changelog) e cria a tag `vX.Y.Z`.
- Commits no padrão Conventional Commits.
- **GitHub Actions**: a cada tag `v*`, o runner Ubuntu compila e gera `.deb`, `.rpm` e `.AppImage`,
  assina as atualizações e publica um GitHub Release com os pacotes, as notas do CHANGELOG e o `latest.json`.
  CI de PR/push roda lint, typecheck e testes.

## 9. Atualização automática

- `tauri-plugin-updater` lê o `latest.json` do release mais recente do repositório oficial.
- Assinatura: chave privada **só** no secret do GitHub (`TAURI_SIGNING_PRIVATE_KEY`, nunca no
  repositório). A chave pública fica embutida no app.
- Comportamento: verifica ao iniciar (no máximo 1×/dia) e no menu "Verificar Atualizações…".
  Mostra as notas da versão e os botões **Instalar e Reiniciar** / **Depois** / **Pular esta versão**.
- AppImage: substitui o próprio arquivo. `.deb`/`.rpm`: baixa o pacote do mesmo formato
  instalado e instala com elevação (`pkexec`), pedindo a senha na janela do sistema.
- O construtor deve confirmar no início que a versão do plugin suporta `.deb`/`.rpm`. Se não
  suportar, implementa esse caminho no Rust (download + verificação da assinatura + `pkexec dnf/apt install`).

## 10. Repositório e página do app

- Repositório público `junior9283/gera-view-image`, licença **MIT** *(minha decisão)*.
- README em pt-BR: logo, descrição, GIF/prints **reais** do app (capturados do build), lista de
  funções com explicação, atalhos, instalação para cada formato (Fedora, Ubuntu/Debian e AppImage),
  como funciona a atualização e como compilar.
- Prints guardados em `docs/screenshots/`, gerados por script, para serem refeitos a cada versão.
- Criar o repositório e fazer push estão autorizados pelo pedido. Os pushes acontecem nos marcos combinados.

## 11. Testes

- Rust: testes unitários das operações de imagem (girar, recortar, redimensionar, filtros,
  Alfa Instantâneo, metadados) com imagens-amostra de cada formato.
- Frontend: Vitest (`pool: 'vmThreads'`, jsdom) para o modelo de anotações, desfazer/refazer, atalhos e lógica de zoom.
- E2E: `tauri-driver` + WebdriverIO no build de produção (abrir, navegar, anotar, exportar).
- Smoke dos pacotes no CI: instalar o `.deb` num container Ubuntu e o `.rpm` num container Fedora e abrir com `--version`.
- Atualização: teste de ponta a ponta com um release de teste (0.1.0 → 0.1.1).

## 12. Abordagens consideradas

| Abordagem | Prós | Contras | Decisão |
|---|---|---|---|
| **Tauri 2** (Rust + React) | ~10 MB, abre rápido, updater assinado, Rust para o processamento pesado | WebKitGTK pode falhar com Nvidia/Wayland (há contorno) | **Escolhida pelo usuário** |
| Electron | Render idêntico em toda distro, updater maduro | ~100 MB, mais RAM, abre mais devagar | Descartada pelo peso |
| GTK4 nativo (Rust) | Mais leve e integrado | Visual macOS difícil, updater do zero, desenvolvimento lento | Descartada |

## 13. Decisões complementares (respostas à revisão)

1. **Updater em `.deb`/`.rpm`**: usar o suporte nativo do `tauri-plugin-updater` se a versão usada o tiver.
   Se não tiver, criar um instalador próprio em Rust: lê o mesmo `latest.json` com chaves por formato
   (`linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-x86_64-rpm`), baixa, verifica a assinatura minisign
   com a chave pública embutida e roda `pkexec apt install ./x.deb` ou `pkexec dnf install ./x.rpm`.
   O formato instalado é detectado no build (variável embutida por bundle) ou em tempo de execução
   (`$APPIMAGE`, `dpkg -S`, `rpm -qf`). **Sem `pkexec` ou instalação recusada**: o app apenas avisa da nova
   versão e oferece abrir a página do release.
2. **Validação WebKitGTK (marco 0)**. Critério: na máquina do usuário (Intel + GTX 1650, Wayland), tanto na GPU
   integrada quanto com `prime-run`/Nvidia, a janela renderiza, uma imagem de 24 MP abre, zoom/pan ficam fluidos
   (sem tela branca, sem piscar) e o canvas de anotação desenha sem atraso perceptível. Testar no AppImage e no `.rpm`.
   Se nenhum contorno (`WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`) resolver,
   **parar e voltar ao usuário** com a proposta de trocar para Electron, sem decidir sozinho.
3. **Decoração da janela**: o padrão é a barra própria estilo macOS (CSD) com `startDragging`/`startResizeDragging`,
   duplo clique para maximizar e cantos arredondados. Se o compositor não suportar transparência ou o
   redimensionamento falhar, o app cai automaticamente na decoração nativa (que também é opção nas Preferências).
4. **Formatos e dependências nativas**: `libheif` (e dav1d/libde265) vai empacotada dentro do AppImage e declarada
   como dependência no `.deb`/`.rpm` (`libheif1` / `libheif`). Leitura de todos os formatos da §5.2 é obrigatória
   na 1.0. Na escrita, JPEG 2000 e OpenEXR podem sair depois da 1.0 se as crates forem inadequadas, e isso
   deve ficar registrado no CHANGELOG. HEIC, WebP, AVIF, PNG, JPEG, TIFF e BMP são obrigatórios na escrita.
5. **Comportamentos detalhados**:
   - *Folha de Contatos*: a barra lateral expande para uma grade de miniaturas grandes que ocupa a janela, e o
     tamanho das miniaturas é ajustável.
   - *Laço Inteligente*: laço com aderência a bordas (gradiente/magnetic lasso simples, *intelligent scissors*
     sobre o mapa de bordas), não segmentação por IA.
   - *Esboço*: reconhece linha, seta, retângulo, oval, estrela e balão. Se não reconhecer, fica o traço livre.
   - *Lupa*: círculo arrastável que mostra a área ampliada, com controle de aumento (alça verde) e de raio (alça azul).
   - *Realce*: retângulo ou oval que mantém a área nítida e escurece o restante da imagem.
6. **Desfazer/Refazer**: modelo **não destrutivo**. O documento é o original + uma lista de operações
   (transformações, ajustes, recortes) + as anotações vetoriais. Desfazer remove a última operação e o Rust
   recalcula, com cache de bitmaps intermediários limitado a ~1 GB (LRU). "Ilimitado" vale para a lista de operações.
7. **Salvar**: Ctrl+S grava no formato original quando ele é gravável. RAW, PSD, SVG, ICO e GIF animado abrem
   "Exportar…" automaticamente. JPEG salva com qualidade estimada do original (padrão 90). EXIF, IPTC e perfil
   ICC são preservados (orientação EXIF normalizada após girar). Há opção no Exportar para remover metadados (incluindo GPS).
8. **GitHub e assinatura**: o `gh` já está autenticado como `junior9283`. O construtor cria o repositório, gera o par
   de chaves com `tauri signer generate`, guarda a privada fora do repositório (em `~/.tauri/`) e
   cadastra os secrets com `gh secret set`, sem nunca imprimir a chave.
9. **Compartilhar e Imprimir**: "Compartilhar" abre um menu com Exportar…, Copiar e Abrir com… (portal
   `org.freedesktop.portal.OpenURI`). Imprimir usa o diálogo de impressão do sistema (GTK/CUPS) com a imagem
   renderizada pelo Rust e opções de ajustar à página e orientação.

## 14. Fica a critério do construtor

Estrutura de pastas, bibliotecas exatas, formato interno das anotações, desenho detalhado dos ícones,
ordem das etapas (respeitando: validação WebKitGTK primeiro, pipeline de release + updater cedo),
e quais funcionalidades entram em cada versão `0.x`.
