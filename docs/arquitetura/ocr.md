# Texto ao Vivo (OCR)

Lote 3. Reconhece texto e QR codes localmente, em Rust puro, sem biblioteca dinâmica nova.

## Motor

| Etapa | Como |
|---|---|
| Detecção | `PP-OCRv5_mobile_det` (DB) no `rten` 0.28 (lê ONNX direto). O mapa de probabilidade vira caixas por componentes conexos: limiar 0,3, nota da caixa ≥ 0,6, expansão de 1,5 × área/perímetro (os padrões do PaddleOCR). As caixas são alinhadas aos eixos, então o texto precisa ser horizontal ou pouco inclinado. |
| Reconhecimento | `latin_PP-OCRv5_mobile_rec` (CTC, entrada 48 px de altura). O dicionário latino (`src-tauri/src/image/ocr_latin_dict.txt`, 502 símbolos) tem os acentos do português. As caixas das palavras saem dos passos de tempo do CTC. |
| Ordem de leitura | Faixas de cima para baixo e, em cada faixa, da esquerda para a direita. |
| QR code | `rqrr` 0.11 (MIT/Apache-2.0 + ISC). |

O `ocrs` foi testado e descartado. O alfabeto dos modelos dele é só ASCII, sem "ã", "ç" ou "é", e os pesos são CC-BY-SA-4.0, licença que não é permissiva. A detecção do `ocrs` também foi trocada pela do PP-OCRv5.

Desempenho medido no protótipo (release, 2 threads): uma imagem de 900×260 com 3 linhas leva cerca de 0,5 s na detecção e 0,4 s no reconhecimento. Em imagens grandes, a detecção roda reduzida (lado maior de 1600 px), e o reconhecimento recorta as linhas da resolução cheia.

## Modelos: baixados sob demanda

| Arquivo | Tamanho | SHA-256 |
|---|---|---|
| `ch_PP-OCRv5_det_mobile.onnx` | 4 819 576 B | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `latin_PP-OCRv5_rec_mobile.onnx` | 7 904 513 B | `b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a` |

- **Origem:** os modelos são do PaddleOCR (PaddlePaddle, Apache-2.0). As conversões ONNX são as publicadas pelo RapidOCR (RapidAI, Apache-2.0) no ModelScope (`RapidAI/RapidOCR`, `onnx/PP-OCRv5/`), que também publica os SHA-256 acima. O PaddlePaddle só publica esses modelos no formato Paddle.
- **Onde ficam:** `~/.local/share/io.github.junior9283.geraviewimage/models/pp-ocrv5/`.
- **Quando são baixados:** só quando o usuário pede, pelo botão do canto ("Ativar o Texto ao Vivo?" › Baixar). O app grava em `.part`, confere o tamanho e o SHA-256 e só então renomeia. Arquivo com hash errado é apagado. O download usa `reqwest` com rustls/ring, os mesmos do atualizador.
- **Por que não vão no pacote:** são 12,7 MB a mais em cada .deb, .rpm e AppImage para um recurso opcional. Eles também não vão no Git.

## Privacidade

O reconhecimento roda no computador. Só três coisas abrem um serviço externo, e todas por escolha explícita do usuário no menu: Traduzir e Pesquisar Texto na Web, que mandam o texto na URL do Google Tradutor ou da busca, e Pesquisar Imagem na Web. Esta última pede confirmação, copia a imagem para a área de transferência e abre o Google Imagens; a imagem só sai do computador se o usuário colar na página. Links, e-mails e telefones detectados abrem com o clique, e o `open_web` só aceita `http(s)`, `mailto:` e `tel:`.

## Fala

Iniciar Fala e Parar Fala usam o `spd-say` do Speech Dispatcher, se estiver instalado. Sem ele, aparece um aviso. O `speechSynthesis` do WebKitGTK não é confiável. Parar Fala roda `spd-say --cancel`, que também cancela mensagens de outros clientes do Speech Dispatcher.

## Testes

- `cargo test --lib ocr`: detecção DB com mapas sintéticos, ordem de leitura, CTC, caixas das palavras, hash, URLs, cache e QR code (gerado pelo `qrcode`, dependência só de teste). Esses testes não baixam nada.
- `tests/ocr.rs` fica `#[ignore]`. Ele renderiza texto em português com as fontes do sistema (resvg) e roda os modelos reais:
  `GVI_OCR_MODELS=<pasta dos modelos> cargo test --release --test ocr -- --ignored`.
- `src/livetext/*.test.ts(x)`: seleção, cópia, Localizar, detectores de dados, download só com confirmação e descarte de resultado obsoleto.
