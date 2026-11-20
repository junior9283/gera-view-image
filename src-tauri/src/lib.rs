pub mod platform;
mod provisional;

use std::time::Instant;

pub fn run() {
    let t0 = Instant::now();
    // Antes de qualquer thread/janela: o WebKitGTK lê estas variáveis ao iniciar.
    platform::webkit::apply_webkit_workarounds(&|k| std::env::var(k).ok(), &mut |k, v| {
        // SAFETY: processo ainda single-thread, nada leu o ambiente em paralelo.
        unsafe { std::env::set_var(k, v) }
    });

    let path = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(provisional::Provisional::new(t0, path))
        .invoke_handler(tauri::generate_handler![
            provisional::render_view,
            provisional::mark_shown
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar o aplicativo Tauri");
}
