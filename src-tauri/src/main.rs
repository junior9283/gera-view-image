// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--version` responde sem abrir janela (usado no smoke dos pacotes no CI).
    if std::env::args()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        println!("gera-view-image {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    gera_view_image_lib::run()
}
