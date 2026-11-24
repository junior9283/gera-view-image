// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--version` responde sem abrir janela (usado no smoke dos pacotes no CI).
    // `args_os`: `args()` entra em pânico com um nome de arquivo que não é UTF-8.
    if gera_view_image_lib::wants_version(std::env::args_os().skip(1)) {
        println!("gera-view-image {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    gera_view_image_lib::run()
}
