//! Limites de memória e segurança: orçamento de decodificação, deduplicação de render,
//! SVG lendo arquivo local, orçamento e prévia de RAW (TIFF/PSD/GIF: testes em decode.rs).
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    commands::docs::Startup,
    doc::{cache::RenderCache, model::Op, store::DocStore},
    image::decode::{self, decode, decode_jpeg_preview},
};
use image::{Rgba, RgbaImage};
use make_fixtures::{ensure_fixtures, png, s, tmp};
use std::{
    path::Path,
    sync::{Arc, Barrier},
};

#[test]
fn abrir_4_grandes_respeita_orcamento_de_decodificacao() {
    let dir = tmp("orcamento");
    let img = RgbaImage::from_fn(2000, 2000, |x, y| Rgba([x as u8, y as u8, 0, 255]));
    let paths: Vec<String> = (0..4)
        .map(|i| {
            let p = dir.join(format!("g{i}.png"));
            png(&p, &img);
            s(&p)
        })
        .collect();
    let uma = 2000 * 2000 * 4;
    // Orçamento de 2,5 imagens: no máximo 2 decodificações cheias ao mesmo tempo.
    let store = DocStore::with_limits(RenderCache::default(), uma * 5 / 2);
    let infos = store.open_documents(&paths);
    assert!(infos.iter().all(|i| i.error.is_none()), "{infos:?}");
    assert!(store.decode_peak_bytes() > 0);
    assert!(
        store.decode_peak_bytes() <= uma * 5 / 2,
        "pico {} > orçamento {}",
        store.decode_peak_bytes(),
        uma * 5 / 2
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn imagem_maior_que_o_orcamento_ainda_abre_sozinha() {
    let dir = tmp("orcamento-unica");
    let p = dir.join("grande.png");
    png(&p, &RgbaImage::new(1000, 1000));
    let store = DocStore::with_limits(RenderCache::default(), 1024);
    let info = store.open_documents(&[s(&p)]).remove(0);
    assert_eq!(info.error, None);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn renders_concorrentes_executam_o_pipeline_uma_vez() {
    let store = DocStore::new();
    let img = RgbaImage::from_fn(4000, 3000, |x, y| Rgba([x as u8, y as u8, 7, 255]));
    let info = store.insert_decoded(
        "/tmp/concorrente.png",
        decode::Decoded::single(img, gera_view_image_lib::doc::model::SourceFormat::Png),
    );
    store
        .apply_op(info.id, Op::Rotate { quarter_turns: 1 })
        .unwrap();
    let barreira = Arc::new(Barrier::new(4));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let (st, b) = (store.clone(), barreira.clone());
            std::thread::spawn(move || {
                b.wait();
                st.render_full(info.id, 0).unwrap().dimensions()
            })
        })
        .collect();
    for t in threads {
        assert_eq!(t.join().unwrap(), (3000, 4000));
    }
    assert_eq!(
        store.pipeline_runs(),
        1,
        "o mesmo (doc, ops, quadro) calculado mais de uma vez"
    );
}

#[test]
fn svg_nao_le_arquivos_locais() {
    let dir = tmp("svg-local");
    let segredo = dir.join("segredo.png");
    png(
        &segredo,
        &RgbaImage::from_pixel(10, 10, Rgba([255, 0, 0, 255])),
    );
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="10">
        <image x="0" y="0" width="10" height="10" href="{}"/>
        <image x="10" y="0" width="10" height="10" xlink:href="segredo.png"/>
        <image x="0" y="0" width="1" height="1" href="/etc/hostname"/></svg>"#,
        segredo.display()
    );
    let p = dir.join("hostil.svg");
    std::fs::write(&p, svg).unwrap();
    let d = decode(&p).unwrap();
    let vermelho = d.frames[0]
        .pixels()
        .filter(|px| px.0[0] > 200 && px.0[3] > 0)
        .count();
    assert_eq!(vermelho, 0, "o SVG leu um arquivo local");

    // data: URL continua funcionando.
    let mut buf = Vec::new();
    RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 255]))
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .unwrap();
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/png;base64,{b64}"/></svg>"#
    );
    std::fs::write(&p, svg).unwrap();
    let d = decode(&p).unwrap();
    let c = d.frames[0].get_pixel(1024, 1024).0;
    assert!(c[0] > 200 && c[3] > 200, "data: URL não renderizou: {c:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn previa_jpeg_orientada_tem_dimensoes_e_giro_corretos() {
    // Quadrante superior esquerdo vermelho; EXIF 6 = girar 90° no sentido horário,
    // então o vermelho vai para o canto superior DIREITO.
    let src = image::RgbImage::from_fn(4000, 3000, |x, y| {
        if x < 2000 && y < 1500 {
            image::Rgb([255, 0, 0])
        } else {
            image::Rgb([0, 0, 255])
        }
    });
    let bytes = make_fixtures::jpeg_with_orientation(&src, 6);
    let p = decode_jpeg_preview(&bytes, 1024).unwrap();
    assert_eq!(p.full_size, (3000, 4000));
    let (w, h) = p.image.dimensions();
    // Lado maior >= 1024: 1/4 daria 1000, então a escala DCT é 1/2; lados trocados pelo EXIF 6.
    assert_eq!((w, h), (1500, 2000), "escala DCT 1/2 e lados trocados");
    let canto_dir = p.image.get_pixel(w - 5, 5).0;
    let canto_esq = p.image.get_pixel(5, 5).0;
    assert!(
        canto_dir[0] > 200 && canto_dir[2] < 60,
        "superior direito deveria ser vermelho: {canto_dir:?}"
    );
    assert!(
        canto_esq[2] > 200,
        "superior esquerdo deveria ser azul: {canto_esq:?}"
    );

    // A prévia guardada no documento (source.frames[0]) tem as mesmas propriedades.
    let dir = tmp("previa-giro");
    let path = dir.join("giro.jpg");
    std::fs::write(&path, &bytes).unwrap();
    let store = DocStore::new();
    let info = store.open_documents(&[s(&path)]).remove(0);
    let (loading, dims, canto) = store
        .with_doc(info.id, |d| {
            let f = &d.source.frames[0];
            (d.loading, f.dimensions(), f.get_pixel(f.width() - 5, 5).0)
        })
        .unwrap();
    if loading {
        assert!(dims.0 < dims.1, "prévia em pé: {dims:?}");
    }
    assert!(canto[0] > 200 && canto[2] < 60, "{canto:?}");
    store.wait_ready(info.id).unwrap();
    let full = store.render_full(info.id, 0).unwrap();
    assert_eq!(full.dimensions(), (3000, 4000));
    assert!(full.get_pixel(2995, 5).0[0] > 200);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn raw_abre_pela_previa_embutida_e_revela_em_segundo_plano() {
    let path = ensure_fixtures().join("img_previa.dng");
    let bytes = std::fs::read(&path).unwrap();
    let previa = decode::raw_preview(&bytes).expect("DNG com prévia embutida");
    assert!(previa.width() > 0);
    let store = DocStore::new();
    let info = store.open_documents(&[s(&path)]).remove(0);
    assert_eq!(info.error, None);
    store.wait_ready(info.id).unwrap();
    let pronto = store.info(info.id).unwrap();
    assert_eq!(
        (pronto.width, pronto.height),
        (64, 48),
        "dimensões da revelação completa"
    );
}

#[test]
fn orcamento_de_raw_usa_o_sensor_e_nao_a_miniatura_do_ifd0() {
    // Como as câmeras gravam: IFD0 = miniatura; o sensor (2000x1500) fica num SubIFD.
    let bytes = make_fixtures::dng_sensor_em_subifd(2000, 1500);
    let ifd0 = imagesize::blob_size(&bytes).unwrap();
    assert!(
        ifd0.width * ifd0.height < 100_000,
        "IFD0 deveria ser a miniatura: {ifd0:?}"
    );
    // Sem isto o teste passaria só pelo piso de 8x o arquivo.
    assert!(
        bytes.len() * 8 < 2000 * 1500 * 12,
        "DNG grande demais: {}",
        bytes.len()
    );
    let est = decode::estimate_bytes(Path::new("sensor.dng"), &bytes);
    assert!(
        est >= 2000 * 1500 * 12,
        "reservou {est} bytes, menos que o sensor x 12"
    );
    assert!(est >= bytes.len() * 8);
}

#[test]
fn composite_aceita_png_como_lista_de_bytes() {
    let json = r#"{"type":"composite","data":{"png":[137,80,78,71]}}"#;
    let op: Op = serde_json::from_str(json).unwrap();
    assert!(matches!(&op, Op::Composite { png, frame: None } if png == &[137, 80, 78, 71]));
    assert_eq!(serde_json::to_string(&op).unwrap(), json);
}

#[test]
fn argumentos_que_comecam_com_hifen_e_existem_sao_arquivos() {
    let dir = tmp("args");
    std::fs::write(dir.join("-foto.png"), b"x").unwrap();
    let args =
        ["--version", "-foto.png", "-nao-existe.png", "normal.jpg"].map(std::ffi::OsString::from);
    let paths = Startup::paths_from_args(args.into_iter(), &dir);
    assert_eq!(
        paths,
        vec![s(&dir.join("-foto.png")), s(&dir.join("normal.jpg"))]
    );
    std::fs::remove_dir_all(&dir).ok();
}
