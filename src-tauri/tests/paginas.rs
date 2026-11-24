//! Documentos de várias páginas (TIFF): cada página tem o próprio tamanho e as próprias edições,
//! e Salvar/Salvar Como/Exportar TIFF gravam todas.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::{
        file::{RevertTarget, SaveOutcome},
        model::{CropSpec, DocId, Op, Rect, ResizeFilter, SourceFormat},
        store::DocStore,
    },
    image::{
        decode::decode,
        encode::{ExportFormat, ExportOptions},
        metadata::file_iim_xmp,
        thumb::view_buffer_size,
    },
};
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb, RgbImage, Rgba, RgbaImage};
use make_fixtures::{ensure_fixtures, s, tmp};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tiff::{
    decoder::{Decoder, DecodingResult},
    encoder::{TiffEncoder, colortype as ct},
    tags::Tag,
};

const TAMANHOS: [(u32, u32); 3] = [(40, 30), (60, 80), (10, 12)];
const CORES: [[u8; 3]; 3] = [[200, 10, 10], [10, 200, 10], [10, 10, 200]];

/// Três páginas de tamanhos e cores diferentes, cada uma com a própria descrição.
fn mistas(path: &Path) {
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for (i, ((w, h), c)) in TAMANHOS.into_iter().zip(CORES).enumerate() {
        let px = RgbImage::from_pixel(w, h, Rgb(c));
        let mut img = e.new_image::<ct::RGB8>(w, h).unwrap();
        img.encoder().write_tag(Tag::ImageDescription, &*format!("pagina {i}")).unwrap();
        img.write_data(px.as_raw()).unwrap();
    }
    fs::write(path, out.into_inner()).unwrap();
}

fn abre(store: &DocStore, path: &Path) -> DocId {
    let info = store.open_documents(&[s(path)]).remove(0);
    assert_eq!(info.error, None, "{}", path.display());
    store.wait_ready(info.id).unwrap();
    info.id
}

fn novo(tag: &str) -> (DocStore, DocId, PathBuf) {
    let path = tmp(tag).join("t.tiff");
    mistas(&path);
    let store = DocStore::new();
    let id = abre(&store, &path);
    (store, id, path)
}

fn corte(x: u32, y: u32, w: u32, h: u32) -> Op {
    Op::Crop(CropSpec::from(Rect { x, y, w, h }))
}

fn vista(store: &DocStore, id: DocId, frame: u32) -> ((u32, u32), [u8; 3]) {
    let b = store.render_view(id, frame, 1000, 1000, None).unwrap();
    (view_buffer_size(&b).unwrap(), [b[8], b[9], b[10]])
}

fn tamanhos(path: &Path) -> Vec<(u32, u32)> {
    decode(path).unwrap().frames.iter().map(RgbaImage::dimensions).collect()
}

fn salva(store: &DocStore, id: DocId) {
    let r = store.save(id, None).unwrap();
    assert!(matches!(r, SaveOutcome::Saved(_)), "{r:?}");
}

fn composite(frame: u32, c: [u8; 4]) -> Op {
    let mut png = Cursor::new(Vec::new());
    RgbaImage::from_pixel(4, 4, Rgba(c)).write_to(&mut png, image::ImageFormat::Png).unwrap();
    Op::Composite { png: png.into_inner(), frame: Some(frame) }
}

// ---------- tamanhos ----------

#[test]
fn cada_pagina_aparece_inteira_no_tamanho_dela() {
    let (store, id, _) = novo("paginas-vista");
    for (f, (size, cor)) in TAMANHOS.into_iter().zip(CORES).enumerate() {
        assert_eq!(vista(&store, id, f as u32), (size, cor), "página {f}");
    }
    // Recorte do visor dentro da página maior que a primeira.
    let r = Rect { x: 50, y: 70, w: 10, h: 10 };
    let b = store.render_view(id, 1, 100, 100, Some(r)).unwrap();
    assert_eq!((view_buffer_size(&b), [b[8], b[9], b[10]]), (Some((10, 10)), CORES[1]));
}

#[test]
fn doc_info_leva_o_tamanho_de_cada_pagina() {
    let (store, id, _) = novo("paginas-info");
    assert_eq!(store.info(id).unwrap().page_sizes, TAMANHOS);
    let png = tmp("paginas-info").join("a.png");
    RgbImage::new(5, 4).save(&png).unwrap();
    let um = abre(&store, &png);
    assert!(store.info(um).unwrap().page_sizes.is_empty());
    // A página pedida não muda nada num documento de uma página.
    let info = store.apply_op_on(um, corte(0, 0, 2, 2), Some(0)).unwrap();
    assert_eq!((info.width, info.height), (2, 2));
    assert!(matches!(store.with_doc(um, |d| d.ops[0].clone()).unwrap(), Op::Crop(_)));
}

// ---------- operações por página ----------

#[test]
fn cortar_vale_so_para_a_pagina_exibida() {
    let (store, id, _) = novo("paginas-cortar");
    // Cabe só na página 2: a validação usa o tamanho dela.
    let info = store.apply_op_on(id, corte(45, 50, 10, 20), Some(1)).unwrap();
    assert_eq!((info.width, info.height), TAMANHOS[0]);
    let want = [(40, 30), (10, 20), (10, 12)];
    assert_eq!(info.page_sizes, want);
    assert_eq!(store.page_sizes(id).unwrap(), want);
    for (f, size) in want.into_iter().enumerate() {
        assert_eq!(vista(&store, id, f as u32), (size, CORES[f]), "página {f}");
    }
    let info = store.undo(id).unwrap();
    assert_eq!((info.page_sizes.as_slice(), info.dirty), (TAMANHOS.as_slice(), false));
    assert_eq!(vista(&store, id, 1), (TAMANHOS[1], CORES[1]));
    assert_eq!(store.redo(id).unwrap().page_sizes[1], (10, 20));
}

#[test]
fn operacao_fora_da_pagina_ou_em_pagina_inexistente_e_recusada() {
    let (store, id, _) = novo("paginas-fora");
    // Fora da página 3 (10x12), mesmo cabendo na 1.
    assert!(store.apply_op_on(id, corte(20, 20, 5, 5), Some(2)).is_err());
    assert_eq!(store.apply_op_on(id, Op::FlipH, Some(9)).unwrap_err().code(), "not_found");
    assert!(!store.info(id).unwrap().can_undo);
}

#[test]
fn girar_e_redimensionar_valem_so_para_a_pagina_exibida() {
    let (store, id, _) = novo("paginas-girar");
    store.apply_op_on(id, Op::Rotate { quarter_turns: 1 }, Some(1)).unwrap();
    let r = Op::Resize { w: 20, h: 24, filter: ResizeFilter::Nearest, dpi: Some(144.0) };
    let info = store.apply_op_on(id, r, Some(2)).unwrap();
    assert_eq!(info.page_sizes, [(40, 30), (80, 60), (20, 24)]);
    assert_eq!(vista(&store, id, 1).0, (80, 60));
    // O DPI do Ajustar Tamanho é da página ajustada.
    assert_eq!(store.current_dpi(id, 2).unwrap(), Some((144.0, 144.0)));
    assert_ne!(store.current_dpi(id, 0).unwrap(), Some((144.0, 144.0)));
}

/// Só `apply_op_on` embrulha a operação: uma já embrulhada (forjada no IPC) é recusada.
#[test]
fn operacao_ja_embrulhada_e_recusada() {
    let (store, id, _) = novo("paginas-aninhada");
    let dentro = |op: Op, frame| Op::OnPage { frame, op: Box::new(op) };
    assert!(store.apply_op(id, dentro(dentro(Op::FlipH, 0), 0)).is_err());
    assert!(store.apply_op(id, dentro(Op::FlipH, 7)).is_err());
    assert!(store.apply_op(id, dentro(composite(1, [0; 4]), 0)).is_err());
    assert!(store.apply_op_on(id, dentro(Op::FlipH, 0), Some(0)).is_err());
    assert!(!store.info(id).unwrap().can_undo);
}

// ---------- gravar ----------

#[test]
fn salvar_grava_todas_as_paginas() {
    let (store, id, path) = novo("paginas-salvar");
    assert!(store.info(id).unwrap().writable);
    store.apply_op_on(id, corte(0, 0, 20, 70), Some(1)).unwrap();
    store.apply_op(id, composite(2, [255, 255, 0, 255])).unwrap();
    salva(&store, id);
    let info = store.info(id).unwrap();
    assert!(!info.dirty);
    let d = decode(&path).unwrap();
    let got: Vec<_> = d.frames.iter().map(|f| (f.dimensions(), f.get_pixel(3, 3).0)).collect();
    let c = |c: [u8; 3]| [c[0], c[1], c[2], 255];
    assert_eq!(got, [((40, 30), c(CORES[0])), ((20, 70), c(CORES[1])), ((10, 12), [255, 255, 0, 255])]);
    // Desfazer depois de salvar volta a sujar; salvar de novo grava o estado desfeito.
    assert!(store.undo(id).unwrap().dirty);
    salva(&store, id);
    assert_eq!(decode(&path).unwrap().frames[2].get_pixel(3, 3).0, c(CORES[2]));
    // Reverter para o original e salvar devolve os tamanhos de antes.
    let info = store.revert(id, RevertTarget::Original).unwrap();
    assert_eq!((info.page_sizes.as_slice(), info.dirty), (TAMANHOS.as_slice(), true));
    salva(&store, id);
    assert_eq!(tamanhos(&path), TAMANHOS);
    // Reler o disco também.
    let info = store.revert(id, RevertTarget::LastSaved).unwrap();
    assert_eq!((info.page_sizes.as_slice(), info.dirty, info.writable), (TAMANHOS.as_slice(), false, true));
}

/// As etiquetas de cada página (aqui a descrição) continuam nela, também depois de outro Salvar.
#[test]
fn salvar_mantem_as_etiquetas_de_cada_pagina() {
    let (store, id, path) = novo("paginas-tags");
    for _ in 0..2 {
        store.apply_op_on(id, Op::FlipH, Some(1)).unwrap();
        salva(&store, id);
        let mut dec = Decoder::new(Cursor::new(fs::read(&path).unwrap())).unwrap();
        for i in 0..3 {
            assert_eq!(dec.get_tag_ascii_string(Tag::ImageDescription).unwrap(), format!("pagina {i}"));
            if i < 2 {
                dec.next_image().unwrap();
            }
        }
        assert!(!dec.more_images());
    }
}

#[test]
fn palavras_chave_nao_perdem_paginas() {
    let (store, id, path) = novo("paginas-chaves");
    store.save(id, Some(vec!["praia".into()])).unwrap();
    assert_eq!(tamanhos(&path), TAMANHOS);
    let (iptc, _) = file_iim_xmp(&fs::read(&path).unwrap());
    assert!(String::from_utf8_lossy(&iptc.unwrap()).contains("praia"));
}

type Rgb16 = ImageBuffer<Rgb<u16>, Vec<u16>>;

/// Três páginas de 16 bits e uma quarta de 8 bits.
fn profundas(path: &Path) -> Vec<Rgb16> {
    let pages: Vec<Rgb16> = TAMANHOS
        .iter()
        .zip(0u16..)
        .map(|(&(w, h), k)| {
            ImageBuffer::from_fn(w, h, |x, y| Rgb([x as u16 * 700 + k, y as u16 * 611 + 3, 12345 + k]))
        })
        .collect();
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for p in &pages {
        e.write_image::<ct::RGB16>(p.width(), p.height(), p.as_raw()).unwrap();
    }
    let px = RgbImage::from_pixel(9, 7, Rgb([1, 2, 3]));
    e.write_image::<ct::RGB8>(9, 7, px.as_raw()).unwrap();
    fs::write(path, out.into_inner()).unwrap();
    pages
}

fn paginas(path: &Path) -> Vec<DynamicImage> {
    let mut dec = Decoder::new(Cursor::new(fs::read(path).unwrap())).unwrap();
    let mut out = Vec::new();
    loop {
        let (w, h) = dec.dimensions().unwrap();
        out.push(match dec.read_image().unwrap() {
            DecodingResult::U16(v) => DynamicImage::ImageRgb16(ImageBuffer::from_raw(w, h, v).unwrap()),
            DecodingResult::U8(v) => DynamicImage::ImageRgb8(ImageBuffer::from_raw(w, h, v).unwrap()),
            _ => panic!("tipo de amostra"),
        });
        if !dec.more_images() {
            return out;
        }
        dec.next_image().unwrap();
    }
}

#[test]
fn salvar_mantem_16_bits_em_todas_as_paginas() {
    let path = tmp("paginas-16").join("t.tiff");
    let pages = profundas(&path);
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op_on(id, corte(10, 10, 20, 30), Some(1)).unwrap();
    salva(&store, id);
    // O segundo Salvar relê o arquivo já gravado e só refaz o que veio depois.
    store.apply_op_on(id, Op::FlipH, Some(2)).unwrap();
    salva(&store, id);
    let got = paginas(&path);
    assert_eq!(got.len(), 4);
    assert_eq!(got[0].as_rgb16().unwrap(), &pages[0]);
    assert_eq!(got[1].as_rgb16().unwrap(), &pages[1].view(10, 10, 20, 30).to_image());
    assert_eq!(got[2].as_rgb16().unwrap(), &image::imageops::flip_horizontal(&pages[2]));
    assert_eq!(got[3].as_rgb8().unwrap().dimensions(), (9, 7), "a página de 8 bits continua de 8");
}

fn opts(format: ExportFormat, all_pages: bool, frame: u32) -> ExportOptions {
    ExportOptions { frame, all_pages, ..ExportOptions::new(format) }
}

#[test]
fn exportar_16_bits_de_uma_pagina_usa_os_16_bits_dela() {
    let path = tmp("paginas-exp16").join("t.tiff");
    let pages = profundas(&path);
    let store = DocStore::new();
    let id = abre(&store, &path);
    let dest = path.with_file_name("uma.tiff");
    let o = ExportOptions { depth16: true, ..opts(ExportFormat::Tiff, false, 1) };
    store.export(id, &s(&dest), &o, None).unwrap();
    assert_eq!(paginas(&dest)[0].as_rgb16().unwrap(), &pages[1]);
}

#[test]
fn salvar_como_e_exportar_tiff_gravam_todas_as_paginas() {
    let (store, id, path) = novo("paginas-como");
    let dir = path.parent().unwrap();
    store.apply_op_on(id, corte(0, 0, 8, 8), Some(0)).unwrap();
    let want = [(8, 8), TAMANHOS[1], TAMANHOS[2]];
    let exp = dir.join("exportado.tiff");
    store.export(id, &s(&exp), &opts(ExportFormat::Tiff, true, 1), None).unwrap();
    assert_eq!(tamanhos(&exp), want);
    let uma = dir.join("uma.tiff");
    store.export(id, &s(&uma), &opts(ExportFormat::Tiff, false, 1), None).unwrap();
    assert_eq!(tamanhos(&uma), [TAMANHOS[1]]);
    let como = dir.join("como.tiff");
    let info = store.save_as(id, &s(&como), &opts(ExportFormat::Tiff, true, 1), None).unwrap();
    assert_eq!((info.path, info.dirty, info.writable), (s(&como), false, true));
    assert_eq!(tamanhos(&como), want);
    // O documento continua com todas as páginas e volta a gravá-las.
    store.apply_op_on(id, Op::Rotate { quarter_turns: 1 }, Some(1)).unwrap();
    salva(&store, id);
    assert_eq!(tamanhos(&como), [(8, 8), (80, 60), TAMANHOS[2]]);
}

/// Salvar Como de uma página só: o arquivo não tem as outras, então o Salvar seguinte grava todas
/// (o documento ainda as tem) e nada é perdido; enquanto isso fica com alterações.
#[test]
fn edicao_de_outra_pagina_fora_do_arquivo_mantem_o_documento_sujo() {
    for (frame, dirty) in [(0, true), (1, false)] {
        let (store, id, path) = novo(&format!("paginas-sujo-{frame}"));
        store.apply_op_on(id, Op::FlipH, Some(1)).unwrap();
        let dest = path.with_extension("png");
        let info = store.save_as(id, &s(&dest), &opts(ExportFormat::Png, false, frame), None).unwrap();
        assert_eq!(info.dirty, dirty, "página {frame}");
        assert!(!info.writable, "um PNG não guarda as outras páginas");
    }
}

/// Redimensionar no Exportar com todas as páginas: cada uma cabe no tamanho, sem ampliar.
#[test]
fn exportar_todas_redimensiona_cada_pagina_na_propria_proporcao() {
    let (store, id, path) = novo("paginas-redim");
    let dest = path.with_file_name("r.tiff");
    let o = ExportOptions { resize: Some((20, 15)), ..opts(ExportFormat::Tiff, true, 0) };
    store.export(id, &s(&dest), &o, None).unwrap();
    assert_eq!(tamanhos(&dest), [(20, 15), (11, 15), (10, 12)]);
}

/// Apagar ou trocar a descrição vale para todas as páginas: o valor antigo não sobra em nenhuma.
#[test]
fn texto_apagado_sai_de_todas_as_paginas() {
    use gera_view_image_lib::commands::describe::MetadataEdits;
    let (store, id, path) = novo("paginas-texto");
    let texto = |t: &str| MetadataEdits { description: Some(t.into()), ..Default::default() };
    let tem = |t: &str| fs::read(&path).unwrap().windows(t.len()).any(|w| w == t.as_bytes());
    store.set_meta_edits(id, &texto("nova"));
    salva(&store, id);
    assert!(!tem("pagina") && tem("nova"));
    store.set_meta_edits(id, &texto(""));
    salva(&store, id);
    assert!(!tem("pagina") && !tem("nova"));
    assert_eq!(tamanhos(&path), TAMANHOS);
}

/// Registros IPTC-IIM 2:xx.
fn iim(registros: &[(u8, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (n, v) in registros {
        out.extend([0x1C, 2, *n]);
        out.extend((v.len() as u16).to_be_bytes());
        out.extend(v.as_bytes());
    }
    out
}

fn xmp(descricao: &str, chaves: &[&str]) -> String {
    let lis: String = chaves.iter().map(|k| format!("<rdf:li>{k}</rdf:li>")).collect();
    format!(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><rdf:Description rdf:about=\"\">\
         <dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{descricao}</rdf:li></rdf:Alt></dc:description>\
         <dc:subject><rdf:Bag>{lis}</rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>"
    )
}

/// Páginas 1 e 2 com descrição e palavras-chave (EXIF, IPTC e XMP); a 3 só com a descrição do TIFF.
fn com_textos(path: &Path) {
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for i in 0..3 {
        let mut img = e.new_image::<ct::RGB8>(4, 3).unwrap();
        img.encoder().write_tag(Tag::ImageDescription, &*format!("segredo {i}")).unwrap();
        if i < 2 {
            let iptc = iim(&[(25, "velha"), (25, "fica"), (120, &format!("legenda velha {i}"))]);
            img.encoder().write_tag(Tag::Unknown(33723), &iptc[..]).unwrap();
            let x = xmp(&format!("xmp velho {i}"), &["velha", "fica"]);
            img.encoder().write_tag(Tag::Unknown(700), x.as_bytes()).unwrap();
        }
        img.write_data(&[9; 36]).unwrap();
    }
    fs::write(path, out.into_inner()).unwrap();
}

/// Bytes do arquivo com a página `n` como primeira (o que os leitores de uma página veem).
fn pagina(bytes: &[u8], n: usize) -> Vec<u8> {
    use gera_view_image_lib::image::container::{tiff_pages, tiff_set_first};
    let mut b = bytes.to_vec();
    tiff_set_first(&mut b, tiff_pages(bytes).unwrap()[n]);
    b
}

/// Trocar uma palavra-chave, a descrição ou o título vale em todas as páginas que têm o campo; nas que
/// não têm, nada é criado. O valor antigo não sobra em nenhum byte do arquivo.
#[test]
fn edicao_de_texto_e_palavras_chave_vale_em_todas_as_paginas() {
    use gera_view_image_lib::commands::describe::MetadataEdits;
    let path = tmp("paginas-privacidade").join("t.tiff");
    com_textos(&path);
    let store = DocStore::new();
    let id = abre(&store, &path);
    let edits = MetadataEdits {
        description: Some("nova descrição".into()),
        title: Some("Título ação".into()),
        ..Default::default()
    };
    store.set_meta_edits(id, &edits);
    store.save(id, Some(vec!["fica".into(), "praia".into()])).unwrap();
    let bytes = fs::read(&path).unwrap();
    let tem = |b: &[u8], t: &str| b.windows(t.len()).any(|w| w == t.as_bytes());
    for velho in ["velha", "segredo", "legenda velha", "xmp velho"] {
        assert!(!tem(&bytes, velho), "{velho:?} sobrou no arquivo");
    }
    assert_eq!(tamanhos(&path), [(4, 3); 3]);
    // Página 2: o valor novo no lugar do antigo; o título, que ela não tinha, não aparece.
    let p2 = pagina(&bytes, 1);
    let (iptc, x) = file_iim_xmp(&p2);
    let (iptc, x) = (String::from_utf8_lossy(&iptc.unwrap()).into_owned(), x.unwrap());
    for (onde, texto) in [(&iptc, "fica"), (&iptc, "praia"), (&iptc, "nova descrição"), (&x, "praia"), (&x, "nova descrição")] {
        assert!(onde.contains(texto), "{texto:?} faltou na página 2");
    }
    assert!(!iptc.contains("Título") && !x.contains("Título"), "título criado na página 2");
    // Página 3: tinha só a descrição; palavras-chave não são criadas.
    let (iptc3, x3) = file_iim_xmp(&pagina(&bytes, 2));
    let iptc3 = String::from_utf8_lossy(&iptc3.unwrap_or_default()).into_owned();
    let x3 = x3.unwrap_or_default();
    assert!(!iptc3.contains("praia") && !x3.contains("praia"), "palavras-chave criadas na página 3");
    assert!(x3.contains("nova descrição") || iptc3.contains("nova descrição"));
}

/// Valor acima do teto do leitor de tags (64 MB): a página entra sem ele, mas a perda fica registrada
/// para o aviso.
#[test]
fn pagina_que_perde_um_valor_grande_e_avisada() {
    use gera_view_image_lib::image::container::{TiffJoin, TiffMeta, tiff_pages, tiff_with_meta};
    let um = || {
        let mut c = Cursor::new(Vec::new());
        TiffEncoder::new(&mut c).unwrap().write_image::<ct::Gray8>(5, 4, &[7; 20]).unwrap();
        c.into_inner()
    };
    let mut j = TiffJoin::new(1 << 28);
    j.push(&um()).unwrap();
    assert!(!j.lost());
    let grande = "x".repeat((64 << 20) + 1);
    j.push(&tiff_with_meta(&um(), &TiffMeta { xmp: Some(&grande), ..Default::default() }).unwrap()).unwrap();
    assert!(j.lost());
    let b = j.finish();
    assert_eq!(tiff_pages(&b).unwrap().len(), 2);
    assert!(b.len() < 64 << 20, "o valor grande não foi copiado");
}

/// TIFF de 4 páginas, cada uma com a própria descrição `disco {i}`.
fn quatro_no_disco(path: &Path) {
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for i in 0..4 {
        let mut img = e.new_image::<ct::RGB8>(2, 2).unwrap();
        img.encoder().write_tag(Tag::ImageDescription, &*format!("disco {i}")).unwrap();
        img.write_data(&[5; 12]).unwrap();
    }
    fs::write(path, out.into_inner()).unwrap();
}

/// O arquivo no disco passou a ter outro número de páginas: cada página do documento ainda leva os
/// metadados da página de mesmo índice, até onde houver.
#[test]
fn paginas_do_disco_diferentes_das_do_documento_casam_por_indice() {
    let (store, id, path) = novo("paginas-indice");
    quatro_no_disco(&path);
    let dest = path.with_file_name("e.tiff");
    store.export(id, &s(&dest), &opts(ExportFormat::Tiff, true, 0), None).unwrap();
    let mut dec = Decoder::new(Cursor::new(fs::read(&dest).unwrap())).unwrap();
    let mut got = Vec::new();
    loop {
        got.push(dec.get_tag_ascii_string(Tag::ImageDescription).ok());
        if !dec.more_images() {
            break;
        }
        dec.next_image().unwrap();
    }
    let want: Vec<_> = (0..3).map(|i| Some(format!("disco {i}"))).collect();
    // A primeira vem do documento (o EXIF lido na abertura), as outras do disco.
    assert_eq!(got[1..], want[1..]);
}

/// Páginas com DPI diferentes: cada uma tem o seu para imprimir, redimensionar e gravar.
#[test]
fn cada_pagina_tem_o_proprio_dpi() {
    use tiff::encoder::Rational;
    let path = tmp("paginas-dpi").join("t.tiff");
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for dpi in [72, 300] {
        let mut img = e.new_image::<ct::RGB8>(2, 2).unwrap();
        img.resolution(tiff::tags::ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
        img.write_data(&[5; 12]).unwrap();
    }
    fs::write(&path, out.into_inner()).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    assert_eq!(store.current_dpi(id, 0).unwrap(), Some((72.0, 72.0)));
    assert_eq!(store.current_dpi(id, 1).unwrap(), Some((300.0, 300.0)));
    let items = gera_view_image_lib::commands::print::items(&store, &[id]).unwrap();
    let dpis: Vec<_> = items.iter().map(|i| i.size.dpi).collect();
    assert_eq!(dpis, [Some((72.0, 72.0)), Some((300.0, 300.0))]);
    // Ajustar Tamanho só da página 1 com 150: a 2 continua com o dela ao gravar.
    let r = Op::Resize { w: 2, h: 2, filter: ResizeFilter::Nearest, dpi: Some(150.0) };
    store.apply_op_on(id, r, Some(0)).unwrap();
    salva(&store, id);
    let outro = DocStore::new();
    let id = abre(&outro, &path);
    let gravados = [outro.current_dpi(id, 0).unwrap(), outro.current_dpi(id, 1).unwrap()];
    assert_eq!(gravados, [Some((150.0, 150.0)), Some((300.0, 300.0))]);
}

// ---------- o arquivo no disco mudou ----------

/// O arquivo virou multipágina e o usuário mandou ignorar a mudança: o Salvar não pode gravar
/// por cima perdendo páginas.
#[test]
fn salvar_nao_apaga_paginas_que_apareceram_no_disco() {
    let path = tmp("paginas-disco").join("t.tiff");
    RgbImage::from_pixel(6, 5, Rgb([9, 9, 9])).save(&path).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipH).unwrap();
    mistas(&path);
    store.accept_disk(id).unwrap();
    assert!(store.save_needs_export(id).unwrap(), "a pergunta prévia concorda com Salvar");
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::NeedsExport));
    assert_eq!(tamanhos(&path), TAMANHOS, "o arquivo ficou como estava");
}

#[test]
fn salvar_nao_grava_por_cima_de_outro_formato() {
    let path = tmp("paginas-formato").join("t.png");
    RgbImage::from_pixel(6, 5, Rgb([9, 9, 9])).save(&path).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    store.apply_op(id, Op::FlipH).unwrap();
    mistas(&path);
    store.accept_disk(id).unwrap();
    assert!(store.save_needs_export(id).unwrap(), "a pergunta prévia concorda com Salvar");
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::NeedsExport));
    assert_eq!(tamanhos(&path), TAMANHOS);
}

#[test]
fn reverter_recalcula_formato_paginas_e_se_da_para_gravar() {
    let dir = tmp("paginas-reverter");
    let path = dir.join("t.png");
    RgbImage::from_pixel(6, 5, Rgb([9, 9, 9])).save(&path).unwrap();
    let store = DocStore::new();
    let id = abre(&store, &path);
    // Virou um TIFF de três páginas: o Recarregar passa a tratá-lo assim.
    mistas(&path);
    let info = store.revert(id, RevertTarget::LastSaved).unwrap();
    assert_eq!((info.frames, info.format), (3, SourceFormat::Tiff));
    store.apply_op_on(id, Op::FlipH, Some(2)).unwrap();
    salva(&store, id);
    assert_eq!(tamanhos(&path), TAMANHOS);
    // Voltar ao original (PNG) com o arquivo agora TIFF: Salvar pede Exportar.
    let info = store.revert(id, RevertTarget::Original).unwrap();
    assert_eq!((info.frames, info.format), (1, SourceFormat::Png));
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::NeedsExport));
    assert_eq!(tamanhos(&path), TAMANHOS);
    // Virou um GIF animado: não dá para gravar por cima.
    fs::copy(ensure_fixtures().join("anim.gif"), &path).unwrap();
    let info = store.revert(id, RevertTarget::LastSaved).unwrap();
    assert!(!info.writable);
    assert!(matches!(store.save(id, None).unwrap(), SaveOutcome::NeedsExport));
}

// ---------- arquivos hostis ----------

/// Páginas demais: recusado, em vez de abrir só a primeira (que o Salvar gravaria sozinha).
#[test]
fn tiff_com_paginas_demais_nao_abre_como_uma_pagina() {
    let path = tmp("paginas-demais").join("t.tiff");
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    for _ in 0..=gera_view_image_lib::image::decode::MAX_PAGES {
        e.write_image::<ct::Gray8>(1, 1, &[7]).unwrap();
    }
    fs::write(&path, out.into_inner()).unwrap();
    assert!(decode(&path).is_err());
}

/// A segunda página só o decodificador de uma página lê: abrir só a primeira perderia a outra.
#[test]
fn tiff_de_varias_paginas_nao_cai_no_leitor_de_uma_pagina() {
    let path = tmp("paginas-fallback").join("t.tiff");
    let mut out = Cursor::new(Vec::new());
    let mut e = TiffEncoder::new(&mut out).unwrap();
    e.write_image::<ct::RGB8>(2, 2, &[9; 12]).unwrap();
    e.write_image::<ct::CMYK8>(2, 2, &[9; 16]).unwrap();
    fs::write(&path, out.into_inner()).unwrap();
    if let Ok(d) = decode(&path) {
        assert_eq!(d.frames.len(), 2, "abriu só uma página");
    }
    // Uma página só continua abrindo pelo leitor alternativo.
    let um = path.with_file_name("u.tiff");
    let mut out = Cursor::new(Vec::new());
    TiffEncoder::new(&mut out).unwrap().write_image::<ct::CMYK8>(2, 2, &[9; 16]).unwrap();
    fs::write(&um, out.into_inner()).unwrap();
    assert_eq!(decode(&um).map(|d| d.frames.len()).ok(), Some(1));
}
