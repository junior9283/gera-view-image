# Fixtures de teste

Todas as fixtures são **geradas localmente** por `tests/make_fixtures.rs`, a partir de
gradientes sintéticos. Não há arquivo baixado da internet, então não há questão de licença:
o conteúdo é original deste repositório (MIT).

O gerador só cria o que falta. Para regenerar tudo, apague esta pasta e rode
`cargo test --test make_fixtures`. O `core.rs` chama o mesmo gerador antes dos testes.

| Arquivo | Tamanho | Como é gerado |
|---|---|---|
| `rgb.jpg` | 40×20, EXIF `Orientation=6` | `image` (JpegEncoder) + segmento APP1 Exif montado à mão |
| `alpha.png` | 30×30 RGBA | `image` |
| `anim.gif` | 16×16, 3 quadros (100/200/300 ms) | `image` (GifEncoder) |
| `multi.tiff` | 2 páginas: 32×24 e 16×16 | `tiff` (TiffEncoder, dois IFDs) |
| `img.webp` | 24×16, sem perdas | `image` (WebPEncoder) |
| `img.avif` | 64×48 | `libheif-rs` + libheif do sistema (codificador AV1 aom) |
| `img.heic` | 64×48 | `libheif-rs` + libheif do sistema (codificador HEVC x265) |
| `img.bmp`, `img.tga` | 20×10 | `image` |
| `img.ico` | 32×32 | `image` |
| `img.svg` | 100×50 (rasteriza em 2048×1024) | texto escrito no gerador |
| `img.psd` | 40×30 RGB 8 bits | PSD mínimo escrito byte a byte (sem camadas, dados crus) |
| `img.dng` | 64×48 | `rawler::dng::writer::DngWriter` (DNG *LinearRaw*, matriz identidade) |
| `truncado.jpg` | — | primeiros 500 bytes de um JPEG 200×200 |
| `texto.png` | — | arquivo de texto com extensão `.png` |
| `Ação com espaço/` | `Ação 1.jpg`, `img2.png`, `img10.png`, `notas.txt` | ordem natural, acentos e filtro de extensões |

## Por que não amostras baixadas

- **HEIC/AVIF**: o libheif desta máquina (1.23, com x265 e aom) codifica as duas, então a
  fixture fica pequena, determinística e sem licença de terceiros.
- **PSD**: o formato sem camadas é simples, e escrever à mão evita depender de um arquivo
  de terceiros. Não cobre PSD com camadas nem compressão RLE. Se um dia for preciso,
  baixar uma amostra de licença clara e registrar aqui.
- **DNG**: o `rawler` grava DNG, mas um DNG *LinearRaw* (já demosaicado) não exercita o
  demosaico de um CFA Bayer real. Os RAW de câmera (CR2/NEF/ARW...) ficam sem fixture.
  Uma candidata é o raw.pixls.us (CC0), mas os arquivos de lá têm de 10 a 60 MB.
