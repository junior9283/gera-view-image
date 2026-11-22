# Lote 3: Texto ao Vivo (OCR): relatório

Base: 49bd354 (Lote 0). Commits: 8bd5ea7 (motor Rust), e88b647 (interface), 8909f1c (docs/CHANGELOG), 719307f (correção de segurança dos links).

## O que foi feito

- **Motor (Rust puro, `src-tauri/src/image/ocr.rs`):**
  - **Detecção:** PP-OCRv5 mobile det (DB, com componentes conexos e expansão "unclip").
  - **Reconhecimento:** latin PP-OCRv5 mobile rec (CTC), ambos rodando no `rten` 0.28, que lê ONNX direto.
  - **Dicionário latino** embutido (502 símbolos, com ã, ç, é, õ…).
  - **Caixas das palavras** saem dos passos de tempo do CTC; a ordem de leitura vai por faixas.
  - **QR code** pelo `rqrr`.
- **Comandos (`src-tauri/src/commands/ocr.rs`):**
  - `recognize_text`, `detect_codes`, `speak`, `stop_speaking` (stubs implementados).
  - `ocr_models`, `download_ocr_models`, `cancel_text_recognition`, `copy_text`, `open_web` (novos; uma linha cada em `lib.rs`).
  - O OCR roda em `blocking`, com cache de 32 entradas por documento, quadro e revisão (a revisão antiga sai). É cancelado por geração: um pedido novo ou a troca de imagem para o anterior.
- **Interface (`src/livetext/*`, slots `viewport-overlay` e `below-toolbar`):**
  - **Seleção e cópia:** arrastar seleciona, duplo clique pega a palavra e triplo a linha; Ctrl+C copia e o menu de contexto oferece Copiar, Pesquisar, Traduzir e Falar.
  - **Ferramentas › Texto ao Vivo:** Copiar Todo o Texto, Traduzir…, Pesquisar Texto…, Pesquisar Imagem na Web… (com confirmação; copia a imagem e abre o Google Imagens, então nada sai sem o usuário colar).
  - **Mostrar Texto ao Vivo** liga e desliga `prefs.liveText`.
  - **Botão no canto:** destaca o texto, os links, e-mails, telefones e QR codes.
  - **Localizar** (Ctrl+F/G/Shift+G) não diferencia maiúsculas nem acentos e leva a ocorrência para a área visível.
  - **Fala** pelo `spd-say`; sem ele, aparece um aviso.

## Decisões

- **ocrs descartado.** O alfabeto dele é só ASCII (sem acentos) e os pesos são CC-BY-SA-4.0, que não é permissiva. O alfabeto foi lido no código-fonte e a licença na página dos modelos; no protótipo só a detecção do `ocrs` rodou.
- **Modelos baixados sob demanda, não no pacote nem no Git.** São 12,7 MB a mais em cada pacote para um recurso opcional.
  - **Origem:** conversões ONNX oficiais do RapidOCR (Apache-2.0) no ModelScope, com SHA-256 fixo.
  - **Download:** grava em `.part`, confere e renomeia. Só começa depois que o usuário confirma no botão do canto, então não há rede automática.
  - Origem, licença e hashes estão em `docs/arquitetura/ocr.md`.
- **Dependências novas:** `rten`/`rten-tensor`, `rqrr`, `sha2`, `url`, `reqwest` (rustls-no-provider) e `rustls`/ring. `reqwest` e `rustls`/ring são os do atualizador; o resto é Rust puro, e a única parte em C é o ring, estático. O `check-needed.sh` rodou só no binário debug (resultado em Testes).
- **Segurança (pedido do coordenador):**
  - `open_web("link")` reconstrói o link com a crate `url`: `http(s)` exige `//host` válido; `mailto:` leva só o endereço e subject/body/cc/bcc, descartando `attach`; `tel:` aceita só dígitos e `+-() `; outros esquemas são recusados.
  - A interface mostra o destino completo no `title` e confirma `mailto:`/`tel:` antes de abrir.
  - Testes RED primeiro: 3 no Rust e 3 no frontend.

## Ajustes pedidos depois da revisão

- **Download:** `https_only`, `connect_timeout` de 15 s e `timeout` de 300 s. Uma guarda `Drop` libera o estado de download mesmo com erro, e o `.part` é apagado se o download ou a conferência falhar.
- **Links:**
  - `http(s)` com userinfo é recusado.
  - O novo comando `inspect_link` devolve o link reconstruído e o host em punycode. A interface mostra esse host no `title`, e um host IDN pede confirmação também em `http(s)`.
  - Testes: no vitest (IDN, `title`, delegação ao Rust e falha de QR) o RED veio antes. No Rust (`http_com_userinfo_e_recusado`, `link_info_devolve_host_ascii_e_marca_idn`) a implementação foi escrita antes da primeira execução; o RED foi provado depois, por mutação (sem a checagem de userinfo e sem a de `xn--`).
- **QR:** se a detecção falhar, o texto do OCR continua e o status fica `ready` (há teste).

## Integração mínima fora dos exclusivos

`Cargo.toml`/`Cargo.lock`, `image/mod.rs` (`pub mod ocr`), 6 linhas em `lib.rs`, linhas novas no bloco do Lote 3 em `ipc/commands.ts` e `ipc/types.ts`, bloco `livetext` no fim de `pt-BR.json`/`en.json`, `CHANGELOG.md` e `docs/arquitetura/ocr.md` (novo).

## Testes

- Rust: `cargo test --lib ocr` com 21 testes (DB, ordem, CTC, palavras, hash, QR, URLs, saneamento de links, cache). Os testes `#[ignore]` de `tests/ocr.rs` com os modelos reais passaram: as três frases em português saíram exatas e o cancelamento funcionou. No CI não há download.
- Frontend: typecheck, lint e 26 testes do lote (`text`, camada, Localizar, controlador, registro, links). 
- `cargo test --no-fail-fast` completo, com os ajustes da revisão: EXIT 0 (lib 95, core 24, file 20, robustez 10, salvar_fiel 11, metadata 6, etc.; 170 no total e 3 `#[ignore]`). `cargo clippy --all-targets`: EXIT 0, e os avisos são todos preexistentes (color, metadata, theme); nenhum vem de `ocr`.
- Mutação (sem as checagens de userinfo e de `xn--`): falharam só `http_com_userinfo_e_recusado` e `link_info_devolve_host_ascii_e_marca_idn`; código restaurado em seguida.
- `check-needed.sh` no binário debug: EXIT 0. Os testes `#[ignore]` com modelos reais não foram repetidos depois dos ajustes, que não tocam o motor.
- `npx vitest run` completo, com os ajustes da revisão: 381/381; typecheck e lint limpos.

## Pendências e limitações

- Texto rotacionado ou vertical não é tratado (as caixas são alinhadas aos eixos).
- Parar Fala usa `spd-say --cancel`, que também cancela outros clientes.
- O Ctrl+C com texto selecionado é tratado por um ouvinte em captura na camada. O lugar certo é a linha `edit.copy` do Lote 2.
- Não houve build release; o `check-needed.sh` rodou só no binário debug. Timeouts, `https_only` e limpeza do estado do download não têm teste automatizado.
- Não houve teste manual no app (GTK/WebKit).
