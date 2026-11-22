//! Núcleo de imagem. O nome colide com a crate `image`: nos submódulos use `::image::`.
pub mod color;
pub mod container;
pub mod decode;
pub mod encode;
pub mod encode_heic;
pub mod encode_jp2;
pub mod heic;
pub mod icc;
pub mod metadata;
pub mod ops;
pub mod raster;
pub mod segment; // Lote 4
pub mod select;
#[cfg(test)]
mod test_util;
pub mod thumb;
