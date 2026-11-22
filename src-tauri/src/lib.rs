pub mod commands;
pub mod doc;
pub mod error;
pub mod image;
pub mod platform;
pub mod theme;

use tauri::{Emitter, Manager, RunEvent};

pub fn run() {
    commands::mark_start();
    // Antes de qualquer thread/janela: o WebKitGTK lê estas variáveis ao iniciar.
    platform::webkit::apply_webkit_workarounds(&|k| std::env::var(k).ok(), &mut |k, v| {
        // SAFETY: processo ainda single-thread, nada leu o ambiente em paralelo.
        unsafe { std::env::set_var(k, v) }
    });

    let store = doc::store::DocStore::new();
    // A decodificação de argv[1..] começa já, em paralelo com a subida do WebView.
    let startup = commands::docs::Startup::spawn(
        store.clone(),
        commands::docs::Startup::paths_from_args(
            std::env::args_os().skip(1),
            &std::env::current_dir().unwrap_or_default(),
        ),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(store)
        .manage(startup)
        .manage(commands::file::PrintJob::default())
        .invoke_handler(tauri::generate_handler![
            commands::docs::open_documents,
            commands::docs::close_document,
            commands::docs::folder_images,
            commands::docs::startup_documents,
            commands::view::render_view,
            commands::view::thumbnail,
            commands::edit::apply_op,
            commands::edit::undo,
            commands::edit::redo,
            commands::edit::instant_alpha,
            commands::edit::snap_lasso,
            commands::edit::copy_region,
            commands::edit::preview_adjust,
            commands::edit::histogram,
            commands::edit::auto_levels,
            commands::meta::metadata,
            commands::file::save,
            commands::file::export,
            commands::file::estimate_size,
            commands::file::heic_encoder_available,
            commands::file::revert,
            commands::file::rename,
            commands::file::move_to,
            commands::file::duplicate,
            commands::file::document_dpi,
            commands::file::path_exists,
            commands::file::ignore_disk_change,
            commands::file::open_with,
            commands::file::reveal,
            commands::file::print_document,
            commands::file::print_image,
            commands::file::print_page,
            commands::file::print_close,
            commands::capture::new_from_clipboard,
            commands::capture::capture_screen,
            commands::theme::window_theme,
            commands::theme::compositing_available,
            commands::drag::start_drag,
            // Lotes de paridade: stubs do Lote 0 (`AppError::Unsupported` até o lote implementar).
            commands::color::display_profile,
            commands::color::list_profiles,
            commands::color::assign_profile,
            commands::color::set_color_management,
            commands::color::document_profile,
            commands::paste::clipboard_image,
            commands::paste::image_file_png,
            commands::paste::copy_image,
            commands::ocr::recognize_text,
            commands::ocr::detect_codes,
            commands::ocr::speak,
            commands::ocr::stop_speaking,
            commands::ocr::ocr_models,
            commands::ocr::download_ocr_models,
            commands::ocr::cancel_text_recognition,
            commands::ocr::copy_text,
            commands::ocr::open_web,
            commands::ocr::inspect_link,
            commands::segment::segment_subject,
            commands::segment::segment_model_ready,
            commands::segment::segment_cancel,
            commands::finder::file_tags,
            commands::finder::set_file_tags,
            commands::finder::set_locked,
            commands::finder::move_to_trash,
            commands::finder::list_versions,
            commands::finder::restore_version,
            commands::finder::save_as,
            commands::finder::file_locked,
            commands::finder::version_preview,
            commands::finder::set_versions_limit,
            commands::share::share_email,
            commands::share::share_device,
            commands::share::open_with_apps,
            commands::share::open_with_app,
            commands::share::share_devices,
            commands::share::share_device_available,
            commands::sidebar::file_stats,
            commands::describe::edit_metadata,
            commands::fonts::system_fonts,
            commands::camera::camera_allow,
            commands::print::export_pdf,
            commands::print::print_native,
            commands::window::new_window,
            commands::window::list_windows,
            commands::window::focus_window,
            commands::window::merge_windows,
            commands::window::scan_image
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<doc::store::DocStore>()
                .set_listener(move |info| {
                    let _ = handle.emit("doc-updated", info);
                });
            app.manage(commands::theme::Compositing(
                commands::theme::probe_compositing(app.handle()),
            ));
            let drag_root = app.path().app_cache_dir()?.join("drag");
            commands::drag::sweep_stale(&drag_root, commands::drag::pid_alive);
            app.manage(commands::drag::DragTemp(
                drag_root.join(std::process::id().to_string()),
            ));
            // Lote 5: versões guardadas a cada Salvar (~/.local/share/gera-view-image/versions).
            doc::versions::configure(app.path().data_dir()?.join("gera-view-image").join("versions"));
            commands::camera::install(app.handle());
            theme::watch::start(app.handle().clone());
            commands::file::start_watch(
                app.handle().clone(),
                app.state::<doc::store::DocStore>().inner().clone(),
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao executar o aplicativo Tauri")
        .run(|app, event| {
            if let RunEvent::Exit = event
                && let Some(temp) = app.try_state::<commands::drag::DragTemp>()
            {
                commands::drag::cleanup(&temp.0);
            }
        });
}
