pub mod commands;
pub mod doc;
pub mod error;
pub mod fsio;
pub mod image;
pub mod platform;
pub mod theme;

use tauri::{Manager, RunEvent};

/// Algum argumento pede só a versão (`--version`/`-V`). Aceita nomes que não são UTF-8.
pub fn wants_version(mut args: impl Iterator<Item = std::ffi::OsString>) -> bool {
    args.any(|a| a == "--version" || a == "-V")
}

pub fn run() {
    commands::mark_start();
    // Antes de qualquer thread/janela: o WebKitGTK lê estas variáveis ao iniciar.
    platform::webkit::apply_webkit_workarounds(&|k| std::env::var(k).ok(), &mut |k, v| {
        // SAFETY: processo ainda single-thread, nada leu o ambiente em paralelo.
        unsafe { std::env::set_var(k, v) }
    });

    let mut context = tauri::generate_context!();
    platform::webkit::apply_safe_window(
        &|k| std::env::var(k).ok(),
        &mut context.config_mut().app.windows,
    );

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
        // Primeiro: uma segunda execução entrega os arquivos a esta e sai antes de abrir janela.
        // O nome no D-Bus vem do `identifier` (o mesmo em .deb, .rpm e AppImage) e é solto no
        // `cleanup_before_exit`, antes do reinício do atualizador.
        .plugin(tauri_plugin_single_instance::init(commands::instance::on_second_instance))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(store)
        .manage(startup)
        .manage(doc::windows::WindowRegistry::default())
        .manage(commands::window::Quitting::default())
        .manage(commands::paste::AnnotationClipboard::default())
        .manage(commands::window::Pongs::default())
        .manage(commands::instance::OpenRequests::default())
        .manage(commands::scan::Scans::default())
        .on_window_event(commands::window::on_event)
        .invoke_handler(commands::window::guard(tauri::generate_handler![
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
            commands::file::save_needs_export,
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
            commands::capture::new_from_clipboard,
            commands::capture::capture_screen,
            commands::theme::window_theme,
            commands::theme::compositing_available,
            commands::theme::screen_ppi,
            commands::drag::start_drag,
            commands::clipfiles::copy_files,
            commands::clipfiles::clipboard_files,
            // Lotes de paridade: stubs do Lote 0 (`AppError::Unsupported` até o lote implementar).
            commands::color::display_profile,
            commands::color::list_profiles,
            commands::color::assign_profile,
            commands::color::set_color_management,
            commands::color::document_profile,
            commands::color::list_proof_profiles,
            commands::color::proof_profile,
            commands::color::set_proof_profile,
            commands::paste::clipboard_image,
            commands::paste::image_file_png,
            commands::paste::copy_image,
            commands::paste::copy_annotations,
            commands::paste::pasted_annotations,
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
            commands::describe::take_meta_notes,
            commands::fonts::system_fonts,
            commands::camera::camera_allow,
            commands::print::export_pdf,
            commands::print::export_tagged,
            commands::print::print_preview,
            commands::print::print_native,
            commands::window::new_window,
            commands::window::list_windows,
            commands::window::focus_window,
            commands::window::merge_windows,
            commands::window::move_documents,
            commands::window::take_documents,
            commands::window::set_window_title,
            commands::window::bring_all_to_front,
            commands::window::focus_open_paths,
            commands::window::seal_window,
            commands::window::unseal_window,
            commands::window::close_window,
            commands::window::close_other_windows,
            commands::window::confirm_quit,
            commands::window::answer_close,
            commands::window::pong,
            commands::window::decline_merge,
            commands::window::cancel_quit,
            commands::window::quit_app,
            commands::instance::take_open_requests,
            commands::scan::scan_available,
            commands::scan::scan_devices,
            commands::scan::scan_options,
            commands::scan::scan_image,
            commands::scan::scan_cancel
        ]))
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<doc::store::DocStore>()
                .set_listener(move |info| {
                    commands::window::emit_to_owner(&handle, info.id, "doc-updated", info);
                });
            app.manage(commands::theme::Compositing(
                commands::theme::probe_compositing(app.handle()),
            ));
            // Pastas `<cache>/{drag,scan}/<pid>` deste processo, sem restos de um antigo com o mesmo pid.
            let temp = |name: &str| -> tauri::Result<std::path::PathBuf> {
                Ok(commands::drag::fresh_temp(
                    &app.path().app_cache_dir()?.join(name),
                    std::process::id(),
                    commands::drag::pid_alive,
                ))
            };
            app.manage(commands::drag::DragTemp(temp("drag")?));
            // Digitalizações: PNG temporário numa pasta 0700 deste processo (some ao abrir).
            app.manage(commands::scan::ScanTemp(temp("scan")?));
            // O reinício do atualizador pode pular o `RunEvent::Exit` (quando o pedido de saída
            // falha); a tabela de recursos é esvaziada em toda saída e roda a limpeza também.
            let handle = app.handle().clone();
            app.resources_table()
                .add(commands::OnDrop::new(move || shutdown(&handle)));
            // Lote 5: versões guardadas a cada Salvar (~/.local/share/gera-view-image/versions).
            doc::versions::configure(app.path().data_dir()?.join("gera-view-image").join("versions"));
            if let Some(window) = app.get_webview_window(doc::windows::MAIN_WINDOW) {
                commands::camera::install(&window);
            }
            theme::watch::start(app.handle().clone());
            commands::file::start_watch(
                app.handle().clone(),
                app.state::<doc::store::DocStore>().inner().clone(),
            );
            Ok(())
        })
        .build(context)
        .expect("erro ao executar o aplicativo Tauri")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                shutdown(app);
            }
        });
}

/// Ao sair (ou reiniciar): nenhum `scanimage` fica para trás e os temporários somem. Pode rodar
/// mais de uma vez.
fn shutdown(app: &tauri::AppHandle) {
    if let Some(temp) = app.try_state::<commands::drag::DragTemp>() {
        commands::drag::cleanup(&temp.0);
    }
    app.state::<commands::scan::Scans>().cancel_all();
    if let Some(temp) = app.try_state::<commands::scan::ScanTemp>() {
        commands::drag::cleanup(&temp.0);
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    #[test]
    fn versao_com_argumento_que_nao_e_utf8() {
        let ruim = OsString::from_vec(vec![b'a', 0xff, 0xfe]);
        assert!(super::wants_version([ruim.clone(), "-V".into()].into_iter()));
        assert!(!super::wants_version([ruim, "foto.png".into()].into_iter()));
    }
}
