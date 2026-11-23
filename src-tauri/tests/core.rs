//! Núcleo de imagem: decodificação, operações, documento, prévias e cache.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::{
        cache::RenderCache,
        model::{CropSpec, DocId, Mask, Op, Rect, ResizeFilter, SourceFormat},
        store::DocStore,
    },
    error::AppError,
    image::{
        decode::{Decoded, decode, folder_images},
        heic,
        ops::apply,
    },
};
use image::{Rgba, RgbaImage};
use make_fixtures::{DIR_ACENTOS, ensure_fixtures, png, s, tmp};
use std::{path::PathBuf, sync::Arc};

fn fx(name: &str) -> PathBuf {
    ensure_fixtures().join(name)
}

fn header(buf: &[u8]) -> (u32, u32) {
    (
        u32::from_le_bytes(buf[0..4].try_into().unwrap()),
        u32::from_le_bytes(buf[4..8].try_into().unwrap()),
    )
}

fn pattern(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        Rgba([
            (x % 251) as u8,
            (y % 241) as u8,
            ((x * 7 + y) % 256) as u8,
            255,
        ])
    })
}

fn decoded(img: RgbaImage) -> Decoded {
    Decoded::single(img, SourceFormat::Png)
}

#[test]
fn decodifica_cada_formato() {
    let casos = [
        ("rgb.jpg", SourceFormat::Jpeg, 20, 40),
        ("alpha.png", SourceFormat::Png, 30, 30),
        ("anim.gif", SourceFormat::Gif, 16, 16),
        ("multi.tiff", SourceFormat::Tiff, 32, 24),
        ("img.webp", SourceFormat::Webp, 24, 16),
        ("img.avif", SourceFormat::Avif, 64, 48),
        ("img.heic", SourceFormat::Heic, 64, 48),
        ("img.bmp", SourceFormat::Bmp, 20, 10),
        ("img.ico", SourceFormat::Ico, 32, 32),
        ("img.tga", SourceFormat::Tga, 20, 10),
        ("img.svg", SourceFormat::Svg, 2048, 1024),
        ("img.psd", SourceFormat::Psd, 40, 30),
        ("img.dng", SourceFormat::Raw, 64, 48),
    ];
    for (nome, formato, w, h) in casos {
        // HEIC é opcional: sem a libde265 no sistema, o contrato é `heic_decoder_missing`
        // (o caso com o decoder ausente à força fica em tests/heic_ausente.rs).
        if formato == SourceFormat::Heic && !heic::hevc_available() {
            let e = decode(&fx(nome)).unwrap_err();
            assert_eq!(e.code(), "heic_decoder_missing", "{nome}: {e:?}");
            continue;
        }
        let d = decode(&fx(nome)).unwrap_or_else(|e| panic!("{nome}: {e:?}"));
        assert_eq!(d.format, formato, "{nome}");
        assert_eq!(d.frames[0].dimensions(), (w, h), "{nome}");
        assert_eq!(d.frames.len(), d.delays_ms.len(), "{nome}");
    }
    let tiff = decode(&fx("multi.tiff")).unwrap();
    assert_eq!(tiff.frames.len(), 2);
    assert_eq!(tiff.frames[1].dimensions(), (16, 16));
}

#[test]
fn aplica_orientacao_exif() {
    let d = decode(&fx("rgb.jpg")).unwrap();
    assert_eq!(d.frames[0].dimensions(), (20, 40));
    assert!(d.exif.is_some(), "EXIF preservado para a Tarefa 10/11");
    // A prévia rápida (abertura) também chega em pé.
    let store = DocStore::new();
    let info = store.open_documents(&[s(&fx("rgb.jpg"))]).remove(0);
    assert_eq!((info.width, info.height), (20, 40));
    let buf = store.render_view(info.id, 0, 1000, 1000, None).unwrap();
    assert_eq!(header(&buf), (20, 40));
}

#[test]
fn truncado_retorna_corrupt() {
    match decode(&fx("truncado.jpg")) {
        Err(AppError::Corrupt(_)) => {}
        outro => panic!("esperava Corrupt, veio {outro:?}"),
    }
}

#[test]
fn texto_png_retorna_unsupported_ou_corrupt() {
    let e = decode(&fx("texto.png")).unwrap_err();
    assert!(
        matches!(e, AppError::Unsupported(_) | AppError::Corrupt(_)),
        "{e:?}"
    );
    assert!(matches!(
        decode(&fx("nao-existe.png")).unwrap_err(),
        AppError::NotFound(_)
    ));
}

#[test]
fn gif_tem_3_quadros_e_delays() {
    let d = decode(&fx("anim.gif")).unwrap();
    assert_eq!(d.frames.len(), 3);
    assert_eq!(d.delays_ms, vec![100, 200, 300]);
}

#[test]
fn open_documents_mistura_valido_e_invalido() {
    let store = DocStore::new();
    let infos = store.open_documents(&[s(&fx("alpha.png")), s(&fx("truncado.jpg"))]);
    assert_eq!(infos.len(), 2);
    assert_eq!(infos[0].error, None);
    assert_eq!((infos[0].width, infos[0].height), (30, 30));
    assert_eq!(infos[1].error.as_deref(), Some("corrupt"));
    assert_ne!(infos[0].id, infos[1].id);
    // O válido continua navegável; o inválido responde erro sem panic.
    assert!(store.render_view(infos[0].id, 0, 100, 100, None).is_ok());
    assert!(store.render_view(infos[1].id, 0, 100, 100, None).is_err());
    assert!(store.apply_op(infos[1].id, Op::FlipH).is_err());
    store.close(infos[1].id).unwrap();
    assert!(store.info(infos[1].id).is_err());
}

#[test]
fn folder_images_ordenacao_natural_e_acentos() {
    let dir = ensure_fixtures().join(DIR_ACENTOS);
    let nomes = |v: Vec<String>| -> Vec<String> {
        v.iter()
            .map(|p| {
                PathBuf::from(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    };
    let esperado = vec![
        "Ação 1.jpg".to_string(),
        "img2.png".into(),
        "img10.png".into(),
    ];
    assert_eq!(nomes(folder_images(&dir).unwrap()), esperado);
    // A partir de um arquivo, lista a pasta dele.
    let lista = folder_images(&dir.join("img10.png")).unwrap();
    assert_eq!(nomes(lista.clone()), esperado);
    // Caminhos com espaço e acento abrem normalmente.
    let infos = DocStore::new().open_documents(&lista);
    assert!(infos.iter().all(|i| i.error.is_none()), "{infos:?}");
    assert_eq!(infos[0].name, "Ação 1.jpg");
}

#[cfg(unix)]
#[test]
fn folder_images_segue_link_so_para_arquivo() {
    use std::os::unix::fs::symlink;
    let dir = tmp("links");
    png(&dir.join("a.png"), &RgbaImage::new(2, 2));
    std::fs::create_dir_all(dir.join("pasta.png")).ok();
    symlink(dir.join("a.png"), dir.join("b.png")).ok();
    symlink(dir.join("pasta.png"), dir.join("c.png")).ok();
    symlink(dir.join("sumiu.png"), dir.join("d.png")).ok();
    let nomes: Vec<String> = folder_images(&dir)
        .unwrap()
        .iter()
        .map(|p| PathBuf::from(p).file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(nomes, ["a.png", "b.png"]);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rotate_4_vezes_volta_ao_original() {
    let orig = pattern(7, 3);
    let mut img = orig.clone();
    for _ in 0..4 {
        img = apply(&img, &Op::Rotate { quarter_turns: 1 });
        assert!(img.dimensions() == (3, 7) || img.dimensions() == (7, 3));
    }
    assert_eq!(img, orig);
    let ida = apply(&orig, &Op::Rotate { quarter_turns: 1 });
    assert_eq!(apply(&ida, &Op::Rotate { quarter_turns: -1 }), orig);
    // Horário: o canto superior esquerdo vai para o superior direito.
    assert_eq!(ida.get_pixel(2, 0), orig.get_pixel(0, 0));
    assert_eq!(apply(&apply(&orig, &Op::FlipH), &Op::FlipH), orig);
    assert_eq!(
        apply(&orig, &Op::FlipV).get_pixel(0, 0),
        orig.get_pixel(0, 2)
    );
}

#[test]
fn crop_dimensoes() {
    let img = pattern(100, 80);
    let c = apply(
        &img,
        &Op::Crop(
            Rect {
                x: 10,
                y: 20,
                w: 50,
                h: 30,
            }
            .into(),
        ),
    );
    assert_eq!(c.dimensions(), (50, 30));
    assert_eq!(c.get_pixel(0, 0), img.get_pixel(10, 20));
    // Retângulo que sai da imagem é recortado ao limite.
    let c = apply(
        &img,
        &Op::Crop(
            Rect {
                x: 90,
                y: 70,
                w: 50,
                h: 30,
            }
            .into(),
        ),
    );
    assert_eq!(c.dimensions(), (10, 10));
}

#[test]
fn resize_lanczos_dimensoes() {
    let img = pattern(100, 80);
    for filter in [
        ResizeFilter::Lanczos3,
        ResizeFilter::Bilinear,
        ResizeFilter::Nearest,
    ] {
        let r = apply(
            &img,
            &Op::Resize {
                w: 37,
                h: 21,
                filter,
                dpi: None,
            },
        );
        assert_eq!(r.dimensions(), (37, 21));
    }
    let r = apply(
        &img,
        &Op::Resize {
            w: 300,
            h: 240,
            filter: ResizeFilter::Lanczos3,
            dpi: Some(144.0),
        },
    );
    assert_eq!(r.dimensions(), (300, 240));
}

#[test]
fn erase_e_make_transparent() {
    use gera_view_image_lib::doc::model::Mask;
    let img = pattern(10, 10);
    let r = apply(
        &img,
        &Op::Erase(Mask::Rect(Rect {
            x: 0,
            y: 0,
            w: 5,
            h: 10,
        })),
    );
    assert_eq!(r.get_pixel(0, 0).0, [0, 0, 0, 0]);
    assert_eq!(r.get_pixel(5, 0), img.get_pixel(5, 0));
    let r = apply(
        &img,
        &Op::MakeTransparent(Mask::Ellipse(Rect {
            x: 0,
            y: 0,
            w: 10,
            h: 10,
        })),
    );
    assert_eq!(r.get_pixel(5, 5).0[3], 0);
    assert_eq!(r.get_pixel(5, 5).0[..3], img.get_pixel(5, 5).0[..3]);
    assert_eq!(r.get_pixel(0, 0).0[3], 255, "canto fora da elipse");
    // Bitmap RLE: 3 fora, 2 dentro, resto fora.
    let r = apply(
        &img,
        &Op::MakeTransparent(Mask::Bitmap {
            w: 10,
            h: 10,
            rle: vec![3, 2],
        }),
    );
    assert_eq!(
        [
            r.get_pixel(2, 0).0[3],
            r.get_pixel(3, 0).0[3],
            r.get_pixel(4, 0).0[3],
            r.get_pixel(5, 0).0[3]
        ],
        [255, 0, 0, 255]
    );
    let tri = Mask::Polygon(vec![(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]);
    let r = apply(&img, &Op::Erase(tri));
    assert_eq!(r.get_pixel(1, 1).0[3], 0);
    assert_eq!(r.get_pixel(9, 9).0[3], 255);
}

#[test]
fn composite_sobrepoe_png() {
    let img = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 255, 255]));
    let mut over = RgbaImage::new(4, 4);
    over.put_pixel(1, 1, Rgba([255, 0, 0, 255]));
    let mut png = Vec::new();
    over.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let r = apply(&img, &Op::Composite { png, frame: None });
    assert_eq!(r.get_pixel(1, 1).0, [255, 0, 0, 255]);
    assert_eq!(r.get_pixel(0, 0).0, [0, 0, 255, 255]);
}

#[test]
fn crop_com_mascara_e_uma_op_so() {
    let img = RgbaImage::from_pixel(20, 20, Rgba([9, 9, 9, 255]));
    let elipse = Mask::Ellipse(Rect {
        x: 2,
        y: 2,
        w: 10,
        h: 10,
    });
    let op = Op::Crop(CropSpec {
        rect: Rect {
            x: 2,
            y: 2,
            w: 10,
            h: 10,
        },
        mask: Some(elipse),
    });
    let c = apply(&img, &op);
    assert_eq!(c.dimensions(), (10, 10));
    assert_eq!(c.get_pixel(0, 0).0, [9, 9, 9, 0], "canto fora da elipse");
    assert_eq!(c.get_pixel(5, 5).0[3], 255);
    // JSON: `mask` é opcional e vai junto do retângulo.
    let json = serde_json::to_value(&op).unwrap();
    assert_eq!(json["data"]["mask"]["type"], "ellipse");
    assert_eq!(json["data"]["w"], 10);

    // Uma op só: um desfazer volta ao original.
    let store = DocStore::new();
    let info = store.insert_decoded("/tmp/mascara.png", decoded(img));
    store.apply_op(info.id, op).unwrap();
    assert_eq!(store.with_doc(info.id, |d| d.ops.len()).unwrap(), 1);
    let u = store.undo(info.id).unwrap();
    assert!(!u.dirty && !u.can_undo);
    assert_eq!((u.width, u.height), (20, 20));
}

#[test]
fn undo_redo() {
    let store = DocStore::new();
    let info = store.open_documents(&[s(&fx("alpha.png"))]).remove(0);
    assert!(!info.dirty && !info.can_undo && !info.can_redo);
    let a = store
        .apply_op(info.id, Op::Rotate { quarter_turns: 1 })
        .unwrap();
    assert!(a.rev > info.rev);
    store
        .apply_op(
            info.id,
            Op::Crop(
                Rect {
                    x: 0,
                    y: 0,
                    w: 10,
                    h: 5,
                }
                .into(),
            ),
        )
        .unwrap();
    let u = store.undo(info.id).unwrap();
    assert!(u.can_redo && u.can_undo && u.dirty);
    assert_eq!(store.with_doc(info.id, |d| d.ops.len()).unwrap(), 1);
    let u = store.undo(info.id).unwrap();
    assert!(!u.dirty && !u.can_undo);
    let r = store.redo(info.id).unwrap();
    assert!(r.dirty);
    let r = store.redo(info.id).unwrap();
    assert_eq!((r.width, r.height), (10, 5));
    assert!(!r.can_redo);
    assert!(store.redo(info.id).is_ok(), "redo sem pilha não falha");
    // Nova operação depois de desfazer limpa o refazer e não reaproveita cache velho.
    store.undo(info.id).unwrap();
    let n = store.apply_op(info.id, Op::FlipH).unwrap();
    assert!(!n.can_redo);
    assert_eq!((n.width, n.height), (30, 30));
    let buf = store.render_view(info.id, 0, 100, 100, None).unwrap();
    assert_eq!(header(&buf), (30, 30));
}

#[test]
fn render_view_reduz_para_caber() {
    let store = DocStore::new();
    let info = store.insert_decoded("/tmp/grande.png", decoded(pattern(8000, 6000)));
    let buf = store.render_view(info.id, 0, 1600, 1200, None).unwrap();
    assert_eq!(header(&buf), (1600, 1200));
    assert_eq!(buf.len(), 8 + 1600 * 1200 * 4);
    // Não amplia e respeita a proporção.
    let buf = store.render_view(info.id, 0, 10000, 300, None).unwrap();
    assert_eq!(header(&buf), (400, 300));
    // Região em coordenadas da imagem.
    let buf = store
        .render_view(
            info.id,
            0,
            1600,
            1200,
            Some(Rect {
                x: 100,
                y: 100,
                w: 400,
                h: 200,
            }),
        )
        .unwrap();
    assert_eq!(header(&buf), (400, 200));
    let thumb = store.thumbnail(info.id, 0, 128).unwrap();
    assert_eq!(header(&thumb), (128, 96));
    assert!(
        store.render_view(info.id, 5, 100, 100, None).is_err(),
        "quadro inexistente"
    );
    assert!(store.render_view(DocId(9999), 0, 100, 100, None).is_err());
}

#[test]
fn cache_respeita_limite() {
    const MB: usize = 1024 * 1024;
    let cache = RenderCache::new(10 * MB);
    let img = Arc::new(RgbaImage::new(512, 512)); // 1 MiB
    for i in 0..30 {
        cache.insert((DocId(1), i, 0), img.clone());
        assert!(cache.total_bytes() <= 10 * MB);
    }
    assert!(
        cache.get(&(DocId(1), 29, 0)).is_some(),
        "o mais recente fica"
    );
    assert!(cache.get(&(DocId(1), 0, 0)).is_none(), "o mais antigo sai");
    // Usar uma entrada a protege da próxima remoção (LRU).
    cache.get(&(DocId(1), 20, 0));
    cache.insert((DocId(1), 30, 0), img.clone());
    assert!(cache.get(&(DocId(1), 20, 0)).is_some());
    // Maior que o limite: não entra.
    cache.insert((DocId(2), 1, 0), Arc::new(RgbaImage::new(2048, 2048)));
    assert!(cache.get(&(DocId(2), 1, 0)).is_none());
    cache.remove_doc(DocId(1));
    assert_eq!(cache.total_bytes(), 0);
    assert!(RenderCache::default().limit() <= 1024 * MB);
}

#[test]
fn jpeg_abre_com_previa_e_completa_em_segundo_plano() {
    let dir = tmp("previa");
    let path = dir.join("grande foto.jpg");
    let src = image::RgbImage::from_fn(4000, 3000, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
    });
    std::fs::write(&path, make_fixtures::jpeg_with_orientation(&src, 6)).unwrap();

    let store = DocStore::new();
    let info = store.open_documents(&[s(&path)]).remove(0);
    assert_eq!(info.error, None);
    assert_eq!(
        (info.width, info.height),
        (3000, 4000),
        "dimensões cheias já na abertura"
    );
    let buf = store.render_view(info.id, 0, 600, 800, None).unwrap();
    assert_eq!(header(&buf), (600, 800));
    store.wait_ready(info.id).unwrap();
    let pronto = store.info(info.id).unwrap();
    assert!(pronto.rev >= info.rev);
    let full = store.render_full(info.id, 0).unwrap();
    assert_eq!(full.dimensions(), (3000, 4000));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn imagem_enorme_nao_aloca_copias() {
    let dir = tmp("enorme");
    let path = dir.join("enorme.png");
    png(
        &path,
        &RgbaImage::from_fn(12000, 9000, |x, y| {
            Rgba([(x / 47) as u8, (y / 35) as u8, 0, 255])
        }),
    );
    let orig = 12000usize * 9000 * 4;
    let store = DocStore::new();
    let info = store.open_documents(&[s(&path)]).remove(0);
    assert_eq!(info.error, None);
    let buf = store.render_view(info.id, 0, 1600, 1600, None).unwrap();
    assert_eq!(header(&buf), (1600, 1200));
    let residente = || store.source_bytes(info.id).unwrap() + store.cache().peak_bytes();
    assert!(
        residente() <= 2 * orig,
        "pico {} > 2x {}",
        residente(),
        orig
    );
    store
        .apply_op(info.id, Op::Rotate { quarter_turns: 1 })
        .unwrap();
    let buf = store.render_view(info.id, 0, 1600, 1600, None).unwrap();
    assert_eq!(header(&buf), (1200, 1600));
    assert!(
        residente() <= 2 * orig,
        "pico {} > 2x {}",
        residente(),
        orig
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn app_error_serializa_code_e_message() {
    let v = serde_json::to_value(AppError::Corrupt("x".into())).unwrap();
    assert_eq!(v, serde_json::json!({ "code": "corrupt", "message": "x" }));
}

#[test]
fn op_serializa_com_type_e_data() {
    let v = serde_json::to_value(Op::Rotate { quarter_turns: -1 }).unwrap();
    assert_eq!(
        v,
        serde_json::json!({ "type": "rotate", "data": { "quarterTurns": -1 } })
    );
    assert_eq!(
        serde_json::to_value(Op::FlipH).unwrap(),
        serde_json::json!({ "type": "flipH" })
    );
    let op: Op = serde_json::from_value(
        serde_json::json!({ "type": "crop", "data": { "x": 1, "y": 2, "w": 3, "h": 4 } }),
    )
    .unwrap();
    assert_eq!(
        op,
        Op::Crop(
            Rect {
                x: 1,
                y: 2,
                w: 3,
                h: 4
            }
            .into()
        )
    );
}

#[test]
fn arquivos_malformados_nao_dao_panic() {
    let dir = tmp("malformado");
    let mut seed = 0x9E37_79B9_u32;
    let mut lixo = |n: usize| -> Vec<u8> {
        (0..n)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect()
    };
    for nome in [
        "rgb.jpg",
        "alpha.png",
        "anim.gif",
        "multi.tiff",
        "img.webp",
        "img.avif",
        "img.heic",
        "img.bmp",
        "img.ico",
        "img.tga",
        "img.svg",
        "img.psd",
        "img.dng",
    ] {
        let bytes = std::fs::read(fx(nome)).unwrap();
        let ext = nome.rsplit('.').next().unwrap();
        // Metade do arquivo, cabeçalho válido + lixo, e só lixo.
        let mut cab_lixo = bytes[..bytes.len().min(16)].to_vec();
        cab_lixo.extend(lixo(2000));
        let casos = [bytes[..bytes.len() / 2].to_vec(), cab_lixo, lixo(3000)];
        for (i, conteudo) in casos.into_iter().enumerate() {
            let p = dir.join(format!("caso{i}.{ext}"));
            std::fs::write(&p, conteudo).unwrap();
            let _ = decode(&p); // Ok ou Err, mas sem panic escapar.
            let info = DocStore::new().open_documents(&[s(&p)]).remove(0);
            assert!(info.error.is_some() || info.width > 0, "{nome} caso {i}");
        }
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn base_da_previa_de_ajuste_fica_em_cache_e_invalida_pela_chave() {
    let store = DocStore::new();
    let info = store.insert_decoded("/tmp/previa-cache.png", decoded(pattern(300, 200)));
    let id = info.id;
    let a = store.preview_base(id, 0, 120, 120).unwrap();
    assert_eq!(*a, store.render_view(id, 0, 120, 120, None).unwrap());
    // Mesma chave: o mesmo buffer, sem novo render.
    let b = store.preview_base(id, 0, 120, 120).unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    // Outro tamanho: outra entrada, e a anterior sai (cache de 1 entrada).
    let c = store.preview_base(id, 0, 60, 60).unwrap();
    assert_eq!(header(&c), (60, 40));
    assert!(!Arc::ptr_eq(&store.preview_base(id, 0, 120, 120).unwrap(), &a));
    // Nova operação muda a chave (ops.len()).
    store.apply_op(id, Op::FlipH).unwrap();
    let d = store.preview_base(id, 0, 120, 120).unwrap();
    assert_eq!(*d, store.render_view(id, 0, 120, 120, None).unwrap());
    assert_ne!(*d, *a);
    // Desfazer e aplicar outra operação do mesmo comprimento muda a geração.
    store.undo(id).unwrap();
    assert_eq!(*store.preview_base(id, 0, 120, 120).unwrap(), *a);
    store.apply_op(id, Op::FlipV).unwrap();
    let e = store.preview_base(id, 0, 120, 120).unwrap();
    assert_eq!(*e, store.render_view(id, 0, 120, 120, None).unwrap());
    assert_ne!(*e, *d);
    assert!(store.preview_base(DocId(9999), 0, 120, 120).is_err());
}

/// Prévia de Ajustar Cor no visor: só a região visível da página mostrada.
#[test]
fn previa_de_ajuste_da_regiao_e_da_pagina() {
    let store = DocStore::new();
    let mut d = decoded(pattern(300, 200));
    d.frames.push(RgbaImage::from_pixel(300, 200, Rgba([9, 8, 7, 255])));
    let id = store.insert_decoded("/tmp/previa-regiao.tif", d).id;
    let r = Rect { x: 40, y: 30, w: 100, h: 80 };
    let a = store.preview_region(id, 0, 50, 50, Some(r)).unwrap();
    assert_eq!(*a, store.render_view(id, 0, 50, 50, Some(r)).unwrap());
    assert!(Arc::ptr_eq(&a, &store.preview_region(id, 0, 50, 50, Some(r)).unwrap()));
    // Outra região e outra página são outras entradas.
    let r2 = Rect { x: 41, ..r };
    assert_eq!(*store.preview_region(id, 0, 50, 50, Some(r2)).unwrap(), store.render_view(id, 0, 50, 50, Some(r2)).unwrap());
    let p = store.preview_region(id, 1, 50, 50, Some(r)).unwrap();
    assert_eq!(*p, store.render_view(id, 1, 50, 50, Some(r)).unwrap());
    assert_ne!(*p, *a);
    assert_eq!(&p[8..12], [9, 8, 7, 255]);
    // Região fora da imagem é cortada, sem pânico.
    let out = Rect { x: u32::MAX, y: u32::MAX, w: u32::MAX, h: u32::MAX };
    assert!(store.preview_region(id, 0, 50, 50, Some(out)).is_ok());
}
