//! OCR de ponta a ponta com os modelos reais (Lote 3). Fica `#[ignore]`: os modelos (~12 MB)
//! não vão no repositório e o CI não baixa nada. Para rodar:
//!
//! ```sh
//! GVI_OCR_MODELS=~/.local/share/io.github.junior9283.geraviewimage/models/pp-ocrv5 \
//!   cargo test --release --test ocr -- --ignored
//! ```
use gera_view_image_lib::image::ocr::{Engine, MODELS, model_ok};
use resvg::{tiny_skia, usvg};
use std::path::PathBuf;

fn models() -> PathBuf {
    let dir = PathBuf::from(std::env::var("GVI_OCR_MODELS").expect("defina GVI_OCR_MODELS"));
    assert!(MODELS.iter().all(|m| model_ok(&dir, m)), "modelos ausentes ou com hash errado em {dir:?}");
    dir
}

/// Texto renderizado com as fontes do sistema (resvg), fundo branco.
fn render(lines: &[&str]) -> image::RgbaImage {
    let body: String = lines
        .iter()
        .enumerate()
        .map(|(i, l)| format!(r#"<text x="30" y="{}" font-family="sans-serif" font-size="36">{l}</text>"#, 60 + i * 70))
        .collect();
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="900" height="{}"><rect width="100%" height="100%" fill="#fff"/>{body}</svg>"##,
        40 + lines.len() * 70
    );
    let mut opt = usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = usvg::Tree::from_str(&svg, &opt).unwrap();
    let size = tree.size().to_int_size();
    let mut pix = tiny_skia::Pixmap::new(size.width(), size.height()).unwrap();
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pix.as_mut());
    image::RgbaImage::from_raw(size.width(), size.height(), pix.take()).unwrap()
}

#[test]
#[ignore = "precisa dos modelos do OCR (GVI_OCR_MODELS)"]
fn reconhece_portugues_com_acentos() {
    let engine = Engine::load(&models()).unwrap();
    let img = render(&["Ação e coração: João não está só.", "Visite https://exemplo.com.br agora", "Telefone (11) 98765-4321"]);
    let lines = engine.recognize(&img, &|| false).unwrap();
    let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(text, ["Ação e coração: João não está só.", "Visite https://exemplo.com.br agora", "Telefone (11) 98765-4321"]);
    // Palavras dentro da linha, da esquerda para a direita.
    let first = &lines[0];
    assert_eq!(first.words.len(), 7);
    assert!(first.words.windows(2).all(|w| w[0].bbox.x + w[0].bbox.w <= w[1].bbox.x + 2));
    assert!(first.words.iter().all(|w| w.bbox.x >= first.bbox.x && w.bbox.x + w.bbox.w <= first.bbox.x + first.bbox.w));
}

#[test]
#[ignore = "precisa dos modelos do OCR (GVI_OCR_MODELS)"]
fn cancelamento_interrompe() {
    let engine = Engine::load(&models()).unwrap();
    let err = engine.recognize(&render(&["Texto"]), &|| true).unwrap_err();
    assert_eq!(err.code(), "unsupported");
}
