fn main() {
    compile_heic_plugin();
    tauri_build::build()
}

/// Compila o plugin libde265 da libheif embutida (fonte copiada pelo `libheif-sys` em
/// `OUT/libheif`, ao lado de `DEP_HEIF_ROOT`) com o shim `native/heic/de265_dl.cc`.
fn compile_heic_plugin() {
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
        .file(src.join("plugins/decoder_libde265.cc"))
        .file("native/heic/de265_dl.cc")
        .compile("gvi_heic");
    println!("cargo:rustc-link-lib=dl");
    println!("cargo:rerun-if-changed=native/heic");
}
