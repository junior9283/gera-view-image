//! Núcleo de imagem. O nome colide com a crate `image`: nos submódulos use `::image::`.
pub mod color;
pub mod decode;
pub mod encode;
pub mod encode_heic;
pub mod encode_jp2;
pub mod heic;
pub mod metadata;
pub mod ops;
pub mod select;
#[cfg(test)]
mod test_util;
pub mod thumb;
