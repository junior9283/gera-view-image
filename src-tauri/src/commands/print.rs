//! Lote 11 (Exportar e Imprimir completos): Exportar como PDF e impressão nativa
//! (`gtk::PrintOperation`). As contas da página ficam em `image/print_layout.rs` e o PDF em
//! `image/pdf.rs`; aqui só a ponte com a interface e com o GTK.
use super::blocking;
use crate::{
    doc::{
        finder,
        model::{DocId, DocInfo, SourceFormat},
        store::{DocStore, Pixels},
    },
    error::{AppError, AppResult},
    image::{
        encode::ExportOptions,
        pdf::Pdf,
        print_layout::{self as layout, Placement, PrintOptions, RectF, Size},
        raster::Raster,
    },
};
use ::image::RgbaImage;
use serde::Serialize;
use std::{borrow::Cow, path::Path};
use tauri::{State, WebviewWindow};

/// Qualidade do JPEG no Exportar como PDF de imagens que já vieram de um formato com perdas.
const PDF_JPEG_QUALITY: u8 = 92;

/// Uma página ou quadro a imprimir/exportar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Item {
    pub id: DocId,
    pub frame: u32,
    pub size: Size,
}

/// Páginas de cada documento, na ordem: todas as de um TIFF, só o primeiro quadro de uma animação.
/// Espera a decodificação (chame fora da thread do GTK).
pub fn items(store: &DocStore, ids: &[DocId]) -> AppResult<Vec<Item>> {
    let mut out = Vec::new();
    for &id in ids {
        store.wait_ready(id)?;
        for ((w, h), frame) in store.page_sizes(id)?.into_iter().zip(0..) {
            let dpi = store.current_dpi(id, frame)?;
            out.push(Item { id, frame, size: Size { w, h, dpi } });
        }
    }
    if out.is_empty() {
        return Err(AppError::NotFound("nada para imprimir".into()));
    }
    Ok(out)
}

/// Pixels da página em sRGB.
fn page_pixels<T>(
    store: &DocStore,
    item: &Item,
    f: impl FnOnce(&RgbaImage) -> T,
) -> AppResult<T> {
    let px: Pixels = store.render_full(item.id, item.frame)?;
    Ok(f(&store.to_srgb(item.id, item.frame, Cow::Borrowed(&*px))))
}

/// PDF com uma página por imagem, em sRGB, do tamanho dela na resolução do documento.
pub fn write_pdf(store: &DocStore, ids: &[DocId], dest: &Path) -> AppResult<()> {
    // O nome vem do diálogo do sistema, que já perguntou se substitui. Um destino que não seja
    // .pdf poderia ser a própria imagem.
    if !dest.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
        return Err(AppError::Unsupported("o destino precisa terminar em .pdf".into()));
    }
    let mut pdf = Pdf::new();
    for item in items(store, ids)? {
        use SourceFormat::*;
        let lossy = matches!(store.info(item.id)?.format, Jpeg | Heic | Avif | Webp | Jp2 | Raw);
        page_pixels(store, &item, |px| {
            let raster = Raster::from(px);
            let alpha = raster.has_alpha();
            let quality = lossy.then_some(PDF_JPEG_QUALITY);
            pdf.add_page(&raster.into_pixels(alpha, false), quality, item.size.dpi)
        })??;
    }
    finder::overwrite(dest, &pdf.finish())
}

#[tauri::command]
pub async fn export_pdf(
    store: State<'_, DocStore>,
    ids: Vec<DocId>,
    dest: String,
) -> AppResult<()> {
    let store = store.inner().clone();
    blocking(move || write_pdf(&store, &ids, Path::new(&dest))).await
}

/// Resultado de [`export_tagged`]: o arquivo foi gravado; `tags_error` diz por que as etiquetas
/// não foram (sistema de arquivos sem atributos de usuário, por exemplo).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggedExport {
    pub info: DocInfo,
    pub tags_error: Option<AppError>,
}

pub fn export_with_tags(
    store: &DocStore,
    id: DocId,
    dest: &str,
    opts: &ExportOptions,
    keywords: Option<Vec<String>>,
    tags: &[String],
) -> AppResult<TaggedExport> {
    // Etiqueta inválida falha antes de gravar o arquivo.
    let tags = finder::normalize_tags(tags)?;
    store.export(id, dest, opts, keywords)?;
    Ok(TaggedExport {
        info: store.info(id)?,
        tags_error: finder::write_tags(Path::new(dest), &tags).err(),
    })
}

/// Exportar com as etiquetas do diálogo (`user.xdg.tags`, Lote 5) no arquivo gravado.
#[tauri::command]
pub async fn export_tagged(
    store: State<'_, DocStore>,
    id: DocId,
    dest: String,
    opts: ExportOptions,
    keywords: Option<Vec<String>>,
    tags: Vec<String>,
) -> AppResult<TaggedExport> {
    let store = store.inner().clone();
    blocking(move || export_with_tags(&store, id, &dest, &opts, keywords, &tags)).await
}

// ---------- impressão ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PreviewItem {
    pub id: DocId,
    pub frame: u32,
    #[serde(flatten)]
    pub placement: Placement,
}

/// Prévia do diálogo: papel e páginas em pontos, com a origem no canto do papel.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrintPreview {
    pub paper_w: f64,
    pub paper_h: f64,
    pub pages: Vec<Vec<PreviewItem>>,
}

pub fn preview(store: &DocStore, ids: &[DocId], opts: PrintOptions) -> AppResult<PrintPreview> {
    let opts = opts.sanitized();
    let items = items(store, ids)?;
    let (paper_w, paper_h) = opts.paper_size();
    let area = opts.printable();
    let pages = (0..layout::page_count(items.len(), opts.per_page))
        .map(|page| {
            layout::page_items(items.len(), opts.per_page, page)
                .into_iter()
                .map(|(c, i)| PreviewItem {
                    id: items[i].id,
                    frame: items[i].frame,
                    placement: layout::place(
                        items[i].size,
                        layout::cell(area, opts.per_page, c),
                        &opts,
                    ),
                })
                .collect()
        })
        .collect();
    Ok(PrintPreview { paper_w, paper_h, pages })
}

#[tauri::command]
pub async fn print_preview(
    store: State<'_, DocStore>,
    ids: Vec<DocId>,
    opts: PrintOptions,
) -> AppResult<PrintPreview> {
    let store = store.inner().clone();
    blocking(move || preview(&store, &ids, opts)).await
}

/// Abre o diálogo de impressão do sistema com as opções já aplicadas e só responde quando o
/// trabalho foi entregue (`true`) ou cancelado (`false`). Os documentos de `ids` precisam ficar
/// abertos até lá (a interface imprime cópias achatadas e as fecha depois).
#[tauri::command]
pub async fn print_native(
    window: WebviewWindow,
    store: State<'_, DocStore>,
    ids: Vec<DocId>,
    opts: PrintOptions,
    title: String,
) -> AppResult<bool> {
    let store = store.inner().clone();
    let (store, items) = blocking(move || {
        let items = items(&store, &ids)?;
        Ok((store, items))
    })
    .await?;
    let (tx, mut rx) = tauri::async_runtime::channel::<AppResult<bool>>(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let parent = win.gtk_window().ok();
            let job = native::Job { store, items, opts: opts.sanitized(), title };
            native::run(job, native::Target::Dialog(parent), move |r| {
                let _ = tx.try_send(r);
            });
        })
        .map_err(|e| AppError::Io(e.to_string()))?;
    rx.recv()
        .await
        .unwrap_or_else(|| Err(AppError::Io("a impressão foi interrompida".into())))
}

/// `gtk::PrintOperation`. Tudo aqui roda na thread do GTK, menos [`render_page`]: o desenho de
/// cada página é adiado (`set_defer_drawing`) enquanto uma thread prepara os pixels, e o diálogo
/// é assíncrono (`allow_async`), então a janela continua respondendo.
pub mod native {
    use super::*;
    use crate::image::print_layout::{Bitmap, Orientation, prepare};
    use gtk::{cairo, gio, glib, prelude::*};
    use std::{cell::RefCell, path::PathBuf, rc::Rc, sync::Arc};

    pub struct Job {
        pub store: DocStore,
        pub items: Vec<Item>,
        pub opts: PrintOptions,
        pub title: String,
    }

    pub enum Target {
        /// Diálogo de impressão do sistema.
        Dialog(Option<gtk::ApplicationWindow>),
        /// Direto para um PDF (testes: nada vai a uma impressora).
        Export(PathBuf),
    }

    thread_local! {
        /// Operações em andamento (o GTK não segura a referência no modo assíncrono).
        static ACTIVE: RefCell<Vec<gtk::PrintOperation>> = const { RefCell::new(Vec::new()) };
        /// Impressora e ajustes da última impressão desta sessão.
        static LAST: RefCell<Option<gtk::PrintSettings>> = const { RefCell::new(None) };
    }

    /// Imprime `job`. `done` recebe `true` (entregue), `false` (cancelado) ou o erro, uma vez só.
    pub fn run(job: Job, target: Target, done: impl FnOnce(AppResult<bool>) + 'static) {
        let Job { store, items, opts, title } = job;
        let op = gtk::PrintOperation::new();
        configure(&op, &opts, &title);
        op.set_n_pages(layout::page_count(items.len(), opts.per_page) as i32);

        let failure: Rc<RefCell<Option<AppError>>> = Rc::default();
        let work = Arc::new((store, items, opts));
        op.connect_draw_page({
            let failure = failure.clone();
            move |op, ctx, page| {
                op.set_defer_drawing();
                let (op, ctx, work) = (op.clone(), ctx.clone(), work.clone());
                let failure = failure.clone();
                let area = RectF { x: 0.0, y: 0.0, w: ctx.width(), h: ctx.height() };
                glib::MainContext::default().spawn_local(async move {
                    let ready = gio::spawn_blocking(move || {
                        let (store, items, opts) = &*work;
                        render_page(store, items, opts, page as usize, area)
                    })
                    .await
                    .unwrap_or_else(|_| Err(AppError::Io("falha ao preparar a página".into())));
                    let drawn = ready.and_then(|bitmaps| {
                        let cr = ctx
                            .cairo_context()
                            .ok_or_else(|| AppError::Io("página sem contexto de desenho".into()))?;
                        bitmaps.into_iter().try_for_each(|b| {
                            paint(&cr, b).map_err(|e| AppError::Io(e.to_string()))
                        })
                    });
                    if let Err(e) = drawn {
                        failure.borrow_mut().get_or_insert(e);
                        op.cancel();
                    }
                    op.draw_page_finish();
                });
            }
        });

        let done = Rc::new(RefCell::new(Some(done)));
        let finish = {
            let done = done.clone();
            move |r: AppResult<bool>| {
                if let Some(f) = done.borrow_mut().take() {
                    f(r);
                }
            }
        };
        op.connect_done({
            let finish = finish.clone();
            move |op, result| {
                let result = match (failure.borrow_mut().take(), result) {
                    (Some(e), _) => Err(e),
                    (None, gtk::PrintOperationResult::Apply) => {
                        remember(op.print_settings());
                        Ok(true)
                    }
                    (None, gtk::PrintOperationResult::Error) => Err(AppError::Io(
                        op.error().map_or_else(|| "falha ao imprimir".into(), |e| e.to_string()),
                    )),
                    _ => Ok(false),
                };
                finish(result);
                release(op);
            }
        });

        ACTIVE.with_borrow_mut(|a| a.push(op.clone()));
        let started = match target {
            Target::Dialog(parent) => {
                op.run(gtk::PrintOperationAction::PrintDialog, parent.as_ref())
            }
            Target::Export(path) => {
                op.set_show_progress(false);
                op.set_export_filename(path);
                op.run(gtk::PrintOperationAction::Export, None::<&gtk::Window>)
            }
        };
        if let Err(e) = started {
            finish(Err(AppError::Io(e.to_string())));
            release(&op);
        }
    }

    /// Solta a operação fora do próprio sinal `done` dela.
    fn release(op: &gtk::PrintOperation) {
        let op = op.clone();
        glib::idle_add_local_once(move || ACTIVE.with_borrow_mut(|a| a.retain(|o| *o != op)));
    }

    /// Escolhas que só valem para um trabalho: na próxima impressão, omitiriam páginas ou
    /// gravariam por cima do mesmo arquivo.
    const ONE_JOB: [&str; 8] = [
        "print-pages",
        "page-ranges",
        "page-set",
        "number-up",
        "scale",
        "output-uri",
        "output-basename",
        "output-dir",
    ];

    /// Guarda a impressora e os ajustes da impressão que terminou.
    pub fn remember(settings: Option<gtk::PrintSettings>) {
        let settings = settings.and_then(|s| s.copy());
        if let Some(s) = &settings {
            ONE_JOB.iter().for_each(|key| s.unset(key));
        }
        LAST.set(settings);
    }

    /// Ajustes para a próxima impressão.
    pub fn next_settings() -> gtk::PrintSettings {
        LAST.with_borrow(|l| l.as_ref().and_then(gtk::PrintSettings::copy)).unwrap_or_default()
    }

    fn configure(op: &gtk::PrintOperation, opts: &PrintOptions, title: &str) {
        let paper = gtk::PaperSize::new(Some(&opts.paper));
        let orientation = match opts.orientation {
            Orientation::Portrait => gtk::PageOrientation::Portrait,
            Orientation::Landscape => gtk::PageOrientation::Landscape,
        };
        let setup = gtk::PageSetup::new();
        setup.set_paper_size_and_default_margins(&paper);
        setup.set_orientation(orientation);
        op.set_default_page_setup(Some(&setup));

        let settings = next_settings();
        settings.set_n_copies(opts.copies as i32);
        settings.set_paper_size(&paper);
        settings.set_orientation(orientation);
        op.set_print_settings(Some(&settings));

        op.set_job_name(title);
        op.set_unit(gtk::Unit::Points);
        op.set_use_full_page(opts.full_page());
        op.set_embed_page_setup(true);
        op.set_allow_async(true);
        op.set_show_progress(true);
    }

    /// Pixels de uma página (fora da thread do GTK). `area`: a área usada do papel, em pontos.
    pub fn render_page(
        store: &DocStore,
        items: &[Item],
        opts: &PrintOptions,
        page: usize,
        area: RectF,
    ) -> AppResult<Vec<Bitmap>> {
        let mut out = Vec::new();
        let cells = layout::page_items(items.len(), opts.per_page, page);
        for (c, i) in &cells {
            let item = &items[*i];
            let cell = layout::cell(area, opts.per_page, *c);
            let bitmap = page_pixels(store, item, |px| {
                // O tamanho de verdade (o da lista pode ser aproximado em páginas editadas).
                let size = Size { w: px.width(), h: px.height(), ..item.size };
                prepare(px, &layout::place(size, cell, opts))
            })?;
            out.extend(bitmap);
        }
        Ok(out)
    }

    /// Desenha sem tocar nos pixels: o PDF embute o JPEG que veio pronto.
    fn paint(cr: &cairo::Context, b: Bitmap) -> Result<(), cairo::Error> {
        let (w, h) = (b.w as i32, b.h as i32);
        let surface =
            cairo::ImageSurface::create_for_data(b.rgb24, cairo::Format::Rgb24, w, h, w * 4)?;
        surface.set_mime_data(cairo::MIME_TYPE_JPEG, b.jpeg)?;
        cr.save()?;
        cr.translate(b.dest.x, b.dest.y);
        cr.scale(b.dest.w / w as f64, b.dest.h / h as f64);
        cr.set_source_surface(&surface, 0.0, 0.0)?;
        cr.paint()?;
        cr.restore()
    }
}
