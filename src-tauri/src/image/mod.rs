//! Núcleo de imagem. O nome colide com a crate `image`: nos submódulos use `::image::`.
pub mod cicp; // L17
pub mod color;
pub mod container;
pub mod decode;
pub mod encode;
pub mod encode_heic;
pub mod encode_jp2;
pub mod encode_psd; // Lote 11
pub mod hdr; // L3
pub mod heic;
pub mod icc;
pub mod icns; // L3
pub mod jxl; // L3
pub mod exifscrub; // Lote 9
pub mod formatinfo; // Lote 9
pub mod makernote; // Lote 9
pub mod metadata;
pub mod metaedit; // Lote 9
pub mod ocr; // Lote 3
pub mod ops;
pub mod pdf; // Lote 11
pub mod print_layout; // Lote 11
pub mod proof; // L12
pub mod raster;
pub mod segment; // Lote 4
pub mod select;
#[cfg(test)]
pub(crate) mod test_util;
pub mod thumb;
pub mod xmpedit; // Lote 9
