fn main() {
    compile_heic_plugins();
    tauri_build::build()
}

/// Compila os plugins HEVC da libheif embutida (fonte copiada pelo `libheif-sys` em
/// `OUT/libheif`, ao lado de `DEP_HEIF_ROOT`) com os shims de `native/heic`, que carregam
/// as bibliotecas com dlopen: libde265 (abrir) e libkvazaar (gravar).
fn compile_heic_plugins() {
    use std::path::PathBuf;
    let root = PathBuf::from(std::env::var("DEP_HEIF_ROOT").expect("libheif-sys embutida"));
    let src = root
        .parent()
        .expect("OUT_DIR do libheif-sys")
        .join("libheif/libheif");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .warnings(false)
        .include(root.join("include"))
        .include(&src)
        .include(src.join("api"))
        .include("native/heic/include")
        // A libheif é compilada com threads. HAVE_KVAZAAR_ENABLE_LOGGING fica de fora de
        // propósito: ver native/heic/kvazaar_dl.cc.
        .define("ENABLE_MULTITHREADING_SUPPORT", "1")
        .file(src.join("plugins/decoder_libde265.cc"))
        .file(src.join("plugins/encoder_kvazaar.cc"))
        .file("native/heic/de265_dl.cc")
        .file("native/heic/kvazaar_dl.cc")
        .compile("gvi_heic");
    println!("cargo:rustc-link-lib=dl");
    println!("cargo:rerun-if-changed=native/heic");
}
