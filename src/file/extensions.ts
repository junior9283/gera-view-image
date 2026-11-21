// Extensões que o núcleo abre (espelho de `ext_format` em src-tauri/src/image/decode.rs; o teste
// de paridade lê o fonte do Rust). Usadas no filtro do diálogo Abrir.
export const SUPPORTED_EXTENSIONS = [
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "dib", "tif", "tiff", "webp", "heic", "heif", "hif",
  "avif", "jp2", "ico", "svg", "psd", "psb", "tga", "icb", "vda", "vst",
  // RAW
  "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "pef",
  "srw", "erf", "3fr", "iiq", "mef", "mos", "kdc", "dcr", "rwl", "x3f",
] as const;
