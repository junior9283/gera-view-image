//! Lote 11: Exportar como PDF, etiquetas no Exportar e a impressão nativa. A impressão só é
//! exercitada pela exportação para PDF do `GtkPrintOperation`: nada vai a uma impressora.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    commands::paste::copied_region,
    commands::print::{
        self, export_with_tags, items,
        native::{self, Job, Target},
        write_pdf,
    },
    doc::{
        finder::{TAGS_ATTR, read_tags},
        model::{DocId, Op, SourceFormat},
        store::DocStore,
    },
    error::AppResult,
    image::{
        decode::Decoded,
        encode::{ExportFormat, ExportOptions, MetaCarry, encode},
        print_layout::{Orientation, PrintFit, PrintOptions},
    },
};
use image::{Rgb, RgbImage, Rgba, RgbaImage};
use make_fixtures::{s, tmp};
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    process::Command,
    rc::Rc,
    time::{Duration, Instant},
};

fn abre(store: &DocStore, path: &Path) -> DocId {
    let info = store.open_documents(&[s(path)]).remove(0);
    assert_eq!(info.error, None, "{}", path.display());
    store.wait_ready(info.id).unwrap();
    info.id
}

fn grava(dir: &Path, name: &str, img: &RgbaImage, opts: &ExportOptions, dpi: f32) -> PathBuf {
    let meta = MetaCarry { dpi: Some((dpi, dpi)), ..MetaCarry::default() };
    let p = dir.join(name);
    fs::write(&p, encode(img, opts, &meta).unwrap()).unwrap();
    p
}

fn lisa(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
    RgbaImage::from_pixel(w, h, Rgba(c))
}

/// TIFF de duas páginas (80×40 e 30×60).
fn tiff_duas_paginas(path: &Path) {
    use tiff::encoder::{TiffEncoder, colortype::RGB8};
    let mut out = std::io::Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for (w, h) in [(80, 40), (30, 60)] {
        let px = RgbImage::from_pixel(w, h, Rgb([200, 10, 10]));
        e.write_image::<RGB8>(w, h, px.as_raw()).unwrap();
    }
    fs::write(path, out.into_inner()).unwrap();
}

fn opts() -> PrintOptions {
    PrintOptions {
        copies: 1,
        scale_percent: None,
        fit: PrintFit::Whole,
        auto_rotate: true,
        per_page: 1,
        paper: "iso_a4".into(),
        orientation: Orientation::Portrait,
    }
}

/// Saída de uma ferramenta do poppler, se estiver instalada.
fn poppler(tool: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(tool).args(args).output().ok()?;
    assert!(out.status.success(), "{tool}: {}", String::from_utf8_lossy(&out.stderr));
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `(páginas, tamanho da primeira em pontos)`.
fn pdf_info(path: &Path) -> Option<(u32, String)> {
    let t = poppler("pdfinfo", &["--", &s(path)])?;
    let field = |k: &str| t.lines().find_map(|l| l.strip_prefix(k)).unwrap().trim().to_string();
    Some((field("Pages:").parse().unwrap(), field("Page size:")))
}

/// Página `n` (de 1) rasterizada.
fn pagina(path: &Path, n: u32, dpi: u32) -> Option<RgbaImage> {
    let base = path.with_extension(format!("p{n}"));
    let (n, dpi) = (n.to_string(), dpi.to_string());
    poppler(
        "pdftoppm",
        &["-png", "-singlefile", "-f", &n, "-l", &n, "-r", &dpi, &s(path), &s(&base)],
    )?;
    Some(image::open(base.with_extension(format!("p{n}.png"))).unwrap().into_rgba8())
}

#[track_caller]
fn perto(px: &Rgba<u8>, want: [u8; 3], tol: u8) {
    assert!(px.0[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= tol), "{px:?} != {want:?}");
}

#[test]
fn pdf_tem_uma_pagina_por_imagem_e_por_pagina_de_tiff() {
    let dir = tmp("pdf-paginas");
    let store = DocStore::new();
    let png = ExportOptions::new(ExportFormat::Png);
    let a = abre(&store, &grava(&dir, "a.png", &lisa(300, 150, [10, 200, 30, 255]), &png, 144.0));
    let tiff = dir.join("b.tiff");
    tiff_duas_paginas(&tiff);
    let b = abre(&store, &tiff);
    let dest = dir.join("saída.pdf");
    write_pdf(&store, &[a, b], &dest).unwrap();
    let bytes = fs::read(&dest).unwrap();
    assert!(bytes.starts_with(b"%PDF-1.4"));
    let text: String = bytes.iter().map(|&c| c as char).collect();
    assert!(text.contains("/Count 3"));
    // 144 ppp no PNG são 5669 px/m (143,99 ppp).
    assert!(text.contains("/MediaBox [0 0 150.00"), "144 ppp");
    assert!(text.contains("/MediaBox [0 0 30.0000 60.0000]"), "segunda página do TIFF");
    assert!(!text.contains("/DCTDecode"), "PNG e TIFF saem sem perdas");
    if let Some((pages, size)) = pdf_info(&dest) {
        assert_eq!(pages, 3);
        assert!(size.starts_with("150.008 x 75"), "{size}");
        perto(pagina(&dest, 1, 72).unwrap().get_pixel(70, 30), [10, 200, 30], 1);
    }
}

#[test]
fn pdf_converte_para_srgb_leva_alfa_e_as_operacoes() {
    let dir = tmp("pdf-cor");
    let store = DocStore::new();
    let p3 = ExportOptions {
        color_profile: Some("display-p3".into()),
        ..ExportOptions::new(ExportFormat::Png)
    };
    let mut img = lisa(60, 30, [215, 93, 31, 255]);
    for y in 0..30 {
        for x in 0..20 {
            img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
        }
    }
    let id = abre(&store, &grava(&dir, "p3.png", &img, &p3, 72.0));
    store.apply_op(id, Op::FlipH).unwrap();
    let dest = dir.join("a.pdf");
    write_pdf(&store, &[id], &dest).unwrap();
    let text: String = fs::read(&dest).unwrap().iter().map(|&c| c as char).collect();
    assert!(text.contains("/SMask"));
    if let Some(px) = pagina(&dest, 1, 72) {
        perto(px.get_pixel(10, 15), [215, 93, 31], 2);
        perto(px.get_pixel(50, 15), [255, 255, 255], 1);
    }
}

/// TIFF de duas páginas de 60×30 com a mesma cor: a 1ª a 144 ppp e com perfil Display P3, a 2ª a
/// 72 ppp e sem perfil (sRGB).
fn tiff_perfil_e_resolucao_por_pagina(path: &Path) {
    use tiff::{
        encoder::{Rational, TiffEncoder, colortype::RGB8},
        tags::{ResolutionUnit, Tag},
    };
    let mut out = std::io::Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    let px = RgbImage::from_pixel(60, 30, Rgb([215, 93, 31]));
    for (dpi, p3) in [(144, true), (72, false)] {
        let mut img = e.new_image::<RGB8>(60, 30).unwrap();
        img.resolution(ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
        if p3 {
            let icc = gera_view_image_lib::image::icc::profile_bytes("display-p3").unwrap();
            img.encoder().write_tag(Tag::IccProfile, &icc[..]).unwrap();
        }
        img.write_data(px.as_raw()).unwrap();
    }
    fs::write(path, out.into_inner()).unwrap();
}

/// Cada página de um TIFF imprime com a própria resolução; o perfil é o da 1ª página e não pode
/// tingir a que não tem perfil.
#[test]
fn tiff_imprime_cada_pagina_com_a_sua_resolucao_e_o_seu_perfil() {
    let dir = tmp("pdf-tiff-pagina");
    let tiff = dir.join("t.tiff");
    tiff_perfil_e_resolucao_por_pagina(&tiff);
    let store = DocStore::new();
    let id = abre(&store, &tiff);
    let dpis: Vec<_> = items(&store, &[id]).unwrap().iter().map(|i| i.size.dpi).collect();
    assert_eq!(dpis, vec![Some((144.0, 144.0)), Some((72.0, 72.0))]);
    let dest = dir.join("t.pdf");
    write_pdf(&store, &[id], &dest).unwrap();
    let text: String = fs::read(&dest).unwrap().iter().map(|&c| c as char).collect();
    assert!(text.contains("/MediaBox [0 0 30.0000 15.0000]"), "1ª página a 144 ppp");
    assert!(text.contains("/MediaBox [0 0 60.0000 30.0000]"), "2ª página a 72 ppp");
    if let Some(p1) = pagina(&dest, 1, 144) {
        // Display P3 → sRGB muda a cor; a página sem perfil fica como está.
        let mut want = [215u8, 93, 31, 255];
        assert!(gera_view_image_lib::image::icc::convert_rgba8(
            &mut want,
            &gera_view_image_lib::image::icc::profile_bytes("display-p3").unwrap(),
            gera_view_image_lib::image::icc::srgb_icc()
        ));
        perto(p1.get_pixel(30, 15), [want[0], want[1], want[2]], 2);
        perto(pagina(&dest, 2, 72).unwrap().get_pixel(30, 15), [215, 93, 31], 2);
    }
}

/// Anotações de uma página só saem nela, na impressão e no PDF.
#[test]
fn anotacao_so_sai_na_sua_pagina() {
    let dir = tmp("pdf-anotacao");
    let store = DocStore::new();
    let tiff = dir.join("t.tiff");
    tiff_duas_paginas(&tiff);
    let id = abre(&store, &tiff);
    let mut png = std::io::Cursor::new(Vec::new());
    lisa(80, 40, [0, 0, 255, 255]).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let op = serde_json::json!({"type": "composite", "data": {"png": png.into_inner(), "frame": 1}});
    store.apply_op(id, serde_json::from_value(op).unwrap()).unwrap();
    let px = |f| store.render_full(id, f).unwrap().get_pixel(5, 5).0;
    assert_eq!((px(0), px(1)), ([200, 10, 10, 255], [0, 0, 255, 255]));
    // Outra ordem e o cache não misturam as páginas.
    store.apply_op(id, Op::FlipH).unwrap();
    assert_eq!((px(1), px(0)), ([0, 0, 255, 255], [200, 10, 10, 255]));
    let dest = dir.join("a.pdf");
    write_pdf(&store, &[id], &dest).unwrap();
    if let Some(a) = pagina(&dest, 1, 72) {
        perto(a.get_pixel(5, 5), [200, 10, 10], 1);
        perto(pagina(&dest, 2, 72).unwrap().get_pixel(5, 5), [0, 0, 255], 1);
    }
}

fn composite(frame: u32) -> Op {
    let mut png = std::io::Cursor::new(Vec::new());
    lisa(80, 40, [0, 0, 255, 255]).write_to(&mut png, image::ImageFormat::Png).unwrap();
    Op::Composite { png: png.into_inner(), frame: Some(frame) }
}

fn opts_pagina(format: &str, frame: u32) -> ExportOptions {
    serde_json::from_value(serde_json::json!({"format": format, "quality": null, "frame": frame})).unwrap()
}

/// Página que não existe é erro, não uma anotação que some.
#[test]
fn anotacao_em_pagina_inexistente_e_recusada() {
    let dir = tmp("pagina-inexistente");
    let store = DocStore::new();
    let tiff = dir.join("t.tiff");
    tiff_duas_paginas(&tiff);
    let id = abre(&store, &tiff);
    assert_eq!(store.apply_op(id, composite(2)).unwrap_err().code(), "not_found");
    assert!(!store.info(id).unwrap().can_undo);
    assert!(store.apply_op(id, composite(1)).is_ok());
}

/// Exportar, estimar e Copiar usam a página pedida.
#[test]
fn exportar_e_copiar_a_pagina_pedida() {
    let dir = tmp("exportar-pagina");
    let store = DocStore::new();
    let tiff = dir.join("t.tiff");
    tiff_duas_paginas(&tiff);
    let id = abre(&store, &tiff);
    store.apply_op(id, composite(1)).unwrap();
    let dest = dir.join("p.png");
    for (frame, size, color) in [(0, (80, 40), [200, 10, 10, 255]), (1, (30, 60), [0, 0, 255, 255])] {
        let opts = opts_pagina("png", frame);
        store.export(id, &s(&dest), &opts, None).unwrap();
        let out = image::open(&dest).unwrap().into_rgba8();
        assert_eq!((out.dimensions(), out.get_pixel(3, 3).0), (size, color), "página {frame}");
        assert_eq!(store.estimate_size(id, &opts).unwrap(), fs::metadata(&dest).unwrap().len());
        let copied = copied_region(&store, id, frame, None, None).unwrap();
        assert_eq!((copied.dimensions(), copied.get_pixel(3, 3).0), (size, color), "página {frame}");
    }
    assert!(store.export(id, &s(&dest), &opts_pagina("png", 2), None).is_err());
}

/// O documento só fica limpo se as anotações achatadas foram todas para o arquivo.
#[test]
fn anotacao_fora_do_arquivo_mantem_o_documento_sujo() {
    let dir = tmp("pagina-pendente");
    let tiff = dir.join("t.tiff");
    tiff_duas_paginas(&tiff);
    for (frame, dirty) in [(0, true), (1, false)] {
        let store = DocStore::new();
        let id = abre(&store, &tiff);
        store.apply_op(id, composite(1)).unwrap();
        // Duplicar e exportar: a cópia adota o arquivo.
        let dup = store.duplicate(id, "cópia").unwrap().id;
        let dest = dir.join(format!("dup{frame}.png"));
        store.export(dup, &s(&dest), &opts_pagina("png", frame), None).unwrap();
        let info = store.info(dup).unwrap();
        assert_eq!((info.path, info.dirty), (s(&dest), dirty), "exportar a página {frame}");
        let dest = dir.join(format!("como{frame}.png"));
        let info = store.save_as(id, &s(&dest), &opts_pagina("png", frame), None).unwrap();
        assert_eq!((info.path, info.dirty), (s(&dest), dirty), "salvar como, página {frame}");
    }
}

#[test]
fn pdf_recusa_destino_que_nao_e_pdf_e_documento_fechado() {
    let dir = tmp("pdf-destino");
    let store = DocStore::new();
    let png = ExportOptions::new(ExportFormat::Png);
    let path = grava(&dir, "a.png", &lisa(4, 4, [1, 2, 3, 255]), &png, 72.0);
    let before = fs::read(&path).unwrap();
    let id = abre(&store, &path);
    assert_eq!(write_pdf(&store, &[id], &path).unwrap_err().code(), "unsupported");
    assert_eq!(fs::read(&path).unwrap(), before);
    let dest = dir.join("x.PDF");
    assert!(write_pdf(&store, &[], &dest).is_err());
    assert!(write_pdf(&store, &[DocId(9999)], &dest).is_err());
    assert!(!dest.exists());
    write_pdf(&store, &[id], &dest).unwrap();
    assert!(dest.exists());
}

#[test]
fn exportar_grava_as_etiquetas() {
    let dir = tmp("export-etiquetas");
    let store = DocStore::new();
    let png = ExportOptions::new(ExportFormat::Png);
    let id = abre(&store, &grava(&dir, "a.png", &lisa(4, 4, [1, 2, 3, 255]), &png, 72.0));
    let dest = dir.join("b.jpg");
    let jpeg = ExportOptions::new(ExportFormat::Jpeg);
    // Etiqueta inválida: nada é gravado.
    let bad = export_with_tags(&store, id, &s(&dest), &jpeg, None, &["a,b".into()]);
    assert!(bad.is_err() && !dest.exists());
    let tags = ["Férias".to_string(), "Praia".into(), "Férias".into()];
    let out = export_with_tags(&store, id, &s(&dest), &jpeg, None, &tags).unwrap();
    assert!(dest.exists());
    match out.tags_error {
        None => assert_eq!(read_tags(&dest).unwrap(), ["Férias", "Praia"]),
        // Sistema de arquivos sem atributos de usuário: o arquivo sai e o motivo é informado.
        Some(e) => assert_eq!(e.code(), "unsupported", "{TAGS_ATTR}: {e}"),
    }
}

#[test]
fn previa_usa_as_mesmas_paginas() {
    let dir = tmp("print-previa");
    let store = DocStore::new();
    let png = ExportOptions::new(ExportFormat::Png);
    let ids: Vec<DocId> = (0..3)
        .map(|i| abre(&store, &grava(&dir, &format!("{i}.png"), &lisa(60, 30, [9, 9, 9, 255]), &png, 72.0)))
        .collect();
    let p = print::preview(&store, &ids, PrintOptions { per_page: 2, ..opts() }).unwrap();
    assert_eq!(p.pages.iter().map(Vec::len).collect::<Vec<_>>(), [2, 1]);
    assert_eq!(p.pages[1][0].id, ids[2]);
    let first = &p.pages[0][0].placement;
    assert!(!first.rotated, "a célula de meia folha já é paisagem");
    assert!(first.rect.x >= 17.9 && first.rect.x + first.rect.w <= p.paper_w - 17.9);
}

/// Roda a operação nativa exportando para PDF e mede a maior pausa do laço do GTK.
fn roda(job: Job, dest: &Path) -> (AppResult<bool>, Duration) {
    let laco = gtk::glib::MainLoop::new(None, false);
    let result = Rc::new(Cell::new(None));
    let worst = Rc::new(Cell::new(Duration::ZERO));
    let last = Rc::new(Cell::new(Instant::now()));
    let tick = gtk::glib::timeout_add_local(Duration::from_millis(5), {
        let (worst, last) = (worst.clone(), last.clone());
        move || {
            worst.set(worst.get().max(last.replace(Instant::now()).elapsed()));
            gtk::glib::ControlFlow::Continue
        }
    });
    native::run(job, Target::Export(dest.to_path_buf()), {
        let (result, laco) = (result.clone(), laco.clone());
        move |r| {
            result.set(Some(r));
            // Pelo laço: um erro imediato chega aqui antes do `run`.
            gtk::glib::idle_add_local_once(move || laco.quit());
        }
    });
    laco.run();
    tick.remove();
    (result.take().expect("terminou"), worst.get().max(last.get().elapsed()))
}

fn job(store: &DocStore, ids: &[DocId], opts: PrintOptions) -> Job {
    Job {
        store: store.clone(),
        items: items(store, ids).unwrap(),
        opts: opts.sanitized(),
        title: "teste".into(),
    }
}

fn imprime(store: &DocStore, ids: &[DocId], opts: PrintOptions, dest: &Path) {
    assert_eq!(roda(job(store, ids, opts), dest).0, Ok(true));
}

/// Um teste só: o GTK vive numa única thread. Sem tela (CI sem Xvfb), não há o que exercitar.
#[test]
fn impressao_nativa_exporta_para_pdf() {
    if gtk::init().is_err() {
        eprintln!("sem tela: impressão nativa não exercitada (use xvfb-run)");
        return;
    }
    let dir = tmp("print-nativa");
    let store = DocStore::new();
    let png = ExportOptions::new(ExportFormat::Png);

    // Imagem inteira, girada: paisagem azul/vermelha numa folha retrato.
    let duas = RgbaImage::from_fn(600, 300, |x, _| {
        if x < 300 { Rgba([20, 40, 220, 255]) } else { Rgba([220, 40, 20, 255]) }
    });
    let a = abre(&store, &grava(&dir, "a.png", &duas, &png, 72.0));
    let dest = dir.join("inteira.pdf");
    imprime(&store, &[a], opts(), &dest);
    let bytes = fs::read(&dest).unwrap();
    assert!(bytes.starts_with(b"%PDF"));
    let has = |b: &[u8], pat: &[u8]| b.windows(pat.len()).any(|w| w == pat);
    assert!(has(&bytes, b"/DCTDecode"), "o JPEG pronto é embutido, sem recompressão no GTK");
    if let Some((pages, size)) = pdf_info(&dest) {
        assert_eq!(pages, 1);
        assert!(size.contains("A4"), "{size}");
        let px = pagina(&dest, 1, 36).unwrap();
        let (w, h) = px.dimensions();
        // 90° no sentido horário: a metade esquerda (azul) vai para cima.
        perto(px.get_pixel(w / 2, h / 4), [20, 40, 220], 8);
        perto(px.get_pixel(w / 2, h * 3 / 4), [220, 40, 20], 8);
        perto(px.get_pixel(2, h / 2), [255, 255, 255], 1);
    }

    // Preencher o papel: cor até a borda.
    let dest = dir.join("cheia.pdf");
    let fill = PrintOptions { fit: PrintFit::Fill, ..opts() };
    imprime(&store, &[a], fill, &dest);
    if let Some(px) = pagina(&dest, 1, 36) {
        perto(px.get_pixel(1, 1), [20, 40, 220], 8);
        perto(px.get_pixel(px.width() - 2, px.height() - 2), [220, 40, 20], 8);
    }

    // Escala: 50% de 600×300 px a 72 ppp na paisagem A4, centralizada.
    let dest = dir.join("escala.pdf");
    let scaled = PrintOptions {
        scale_percent: Some(50),
        orientation: Orientation::Landscape,
        ..opts()
    };
    imprime(&store, &[a], scaled.clone(), &dest);
    if let Some(px) = pagina(&dest, 1, 72) {
        assert!(px.width() > px.height(), "paisagem");
        // No mesmo lugar (±2 pt) em que a prévia mostrou.
        let r = print::preview(&store, &[a], scaled).unwrap().pages[0][0].placement.rect;
        assert!((r.w - 300.0).abs() < 0.1 && (r.h - 150.0).abs() < 0.1, "{r:?}");
        let at = |x: f64, y: f64| px.get_pixel(x.round() as u32, y.round() as u32);
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        perto(at(r.x + 3.0, cy), [20, 40, 220], 8);
        perto(at(r.x + r.w - 3.0, cy), [220, 40, 20], 8);
        perto(at(cx - 9.0, r.y + 3.0), [20, 40, 220], 8);
        perto(at(cx - 9.0, r.y + r.h - 3.0), [20, 40, 220], 8);
        for (x, y) in [(r.x - 3.0, cy), (r.x + r.w + 3.0, cy), (cx, r.y - 3.0), (cx, r.y + r.h + 3.0)] {
            perto(at(x, y), [255, 255, 255], 1);
        }
    }

    // Várias imagens, duas por página, e as duas páginas do TIFF.
    let tiff = dir.join("t.tiff");
    tiff_duas_paginas(&tiff);
    let t = abre(&store, &tiff);
    let dest = dir.join("varias.pdf");
    let two = PrintOptions { per_page: 2, ..opts() };
    imprime(&store, &[a, t], two, &dest);
    if let Some((pages, _)) = pdf_info(&dest) {
        assert_eq!(pages, 2);
    }

    // Imagem grande: o laço do GTK não para enquanto a página é preparada.
    let grande = RgbaImage::from_fn(6000, 4000, |x, y| {
        Rgba([(x * 7 + y) as u8, (x ^ y) as u8, (y * 3) as u8, 255])
    });
    let g = store.insert_decoded("", Decoded::single(grande, SourceFormat::Png)).id;
    let dest = dir.join("grande.pdf");
    let (r, pausa) = roda(job(&store, &[g], opts()), &dest);
    assert_eq!(r, Ok(true));
    eprintln!("24 MP: maior pausa do laço do GTK = {pausa:?}");
    assert!(pausa < Duration::from_millis(700), "o GTK ficou parado por {pausa:?}");
    assert!(has(&fs::read(&dest).unwrap(), b"/DCTDecode"));

    // A impressora é lembrada; o que era só daquele trabalho, não.
    const ONE_JOB: [&str; 8] = [
        "print-pages", "page-ranges", "page-set", "number-up", "scale", "output-uri", "output-basename", "output-dir",
    ];
    let s = gtk::PrintSettings::new();
    s.set("printer", Some("Sala"));
    for key in ONE_JOB {
        s.set(key, Some("2"));
    }
    native::remember(Some(s));
    let next = native::next_settings();
    assert_eq!(next.get("printer").as_deref(), Some("Sala"));
    for key in ONE_JOB {
        assert_eq!(next.get(key), None, "{key}");
    }

    // Documento fechado no meio: erro, sem travar nem deixar a operação pendurada.
    let x = abre(&store, &grava(&dir, "x.png", &duas, &png, 72.0));
    let pending = job(&store, &[x], opts());
    store.close(x).unwrap();
    let (r, _) = roda(pending, &dir.join("fechado.pdf"));
    assert_eq!(r.unwrap_err().code(), "not_found");
}
