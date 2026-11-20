pub mod commands;
pub mod doc;
pub mod error;
pub mod image;
pub mod platform;
pub mod theme;

use tauri::{Emitter, Manager};

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
        .manage(store)
        .manage(startup)
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
            commands::edit::preview_adjust,
            commands::edit::histogram,
            commands::edit::auto_levels,
            commands::theme::window_theme,
            commands::theme::compositing_available
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
            theme::watch::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar o aplicativo Tauri");
}
