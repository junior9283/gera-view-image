//! Pixels a gravar: RGBA8 (o pipeline normal) ou RGBA16 (Salvar de PNG/TIFF de 16 bits).
//!
//! O documento trabalha em 8 bits. Para não perder profundidade ao Salvar, o arquivo de 16
//! bits é relido e as mesmas operações são refeitas aqui em 16 bits (ajustes de cor em f32).
use super::{color, ops};
use crate::doc::model::{CropSpec, Mask, Op, ResizeFilter, SourceFormat};
use ::image::{
    ColorType, DynamicImage, ImageBuffer, ImageDecoder, ImageFormat, ImageReader, Rgb, Rgba,
    RgbaImage, imageops, metadata::Orientation,
};
use rayon::prelude::*;
use std::{borrow::Cow, io::Cursor};

/// RGBA com 16 bits por canal (a crate `image` não exporta o apelido).
pub type Rgba16Image = ImageBuffer<Rgba<u16>, Vec<u16>>;
type Rgb16Image = ImageBuffer<Rgb<u16>, Vec<u16>>;

/// Imagem a codificar.
pub enum Raster<'a> {
    Rgba8(Cow<'a, RgbaImage>),
    Rgba16(Cow<'a, Rgba16Image>),
}

impl<'a> From<&'a RgbaImage> for Raster<'a> {
    fn from(i: &'a RgbaImage) -> Self {
        Raster::Rgba8(Cow::Borrowed(i))
    }
}

impl<'a> From<&'a Rgba16Image> for Raster<'a> {
    fn from(i: &'a Rgba16Image) -> Self {
        Raster::Rgba16(Cow::Borrowed(i))
    }
}

impl<'a> Raster<'a> {
    pub fn dimensions(&self) -> (u32, u32) {
        match self {
            Raster::Rgba8(i) => i.dimensions(),
            Raster::Rgba16(i) => i.dimensions(),
        }
    }

    /// Redimensionada com Lanczos3 (sem cópia se o tamanho já for esse).
    pub fn resized(self, w: u32, h: u32) -> Raster<'a> {
        if (w, h) == self.dimensions() {
            return self;
        }
        match self {
            Raster::Rgba8(i) => Raster::Rgba8(Cow::Owned(ops::resize(&i, w, h, ResizeFilter::Lanczos3))),
            Raster::Rgba16(i) => Raster::Rgba16(Cow::Owned(resize16(&i, w, h, ResizeFilter::Lanczos3))),
        }
    }

    pub fn has_alpha(&self) -> bool {
        match self {
            Raster::Rgba8(i) => i.par_chunks_exact(4).any(|p| p[3] != u8::MAX),
            Raster::Rgba16(i) => i.par_chunks_exact(4).any(|p| p[3] != u16::MAX),
        }
    }

    /// Pixels finais: com alfa ou compostos sobre branco; 16 bits por canal só com `deep`
    /// (de 8 bits, os valores são expandidos).
    pub fn into_pixels(self, alpha: bool, deep: bool) -> DynamicImage {
        match (self, deep) {
            (Raster::Rgba16(i), true) if alpha => DynamicImage::ImageRgba16(i.into_owned()),
            (Raster::Rgba16(i), true) => DynamicImage::ImageRgb16(rgb16_on_white(&i)),
            (Raster::Rgba16(i), false) => {
                let i8 = DynamicImage::ImageRgba16(i.into_owned()).into_rgba8();
                Raster::Rgba8(Cow::Owned(i8)).into_pixels(alpha, false)
            }
            (Raster::Rgba8(i), deep) => {
                let px = if alpha {
                    DynamicImage::ImageRgba8(i.into_owned())
                } else {
                    DynamicImage::ImageRgb8(rgb_on_white(&i))
                };
                match px {
                    DynamicImage::ImageRgb8(_) if deep => DynamicImage::ImageRgb16(px.into_rgb16()),
                    _ if deep => DynamicImage::ImageRgba16(px.into_rgba16()),
                    px => px,
                }
            }
        }
    }
}

/// RGB8 com a transparência composta sobre branco (formatos sem alfa), numa passada só.
pub(super) fn rgb_on_white(img: &RgbaImage) -> ::image::RgbImage {
    ::image::RgbImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        let a = p[3] as u32;
        let c = |v: u8| ((v as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
        ::image::Rgb([c(p[0]), c(p[1]), c(p[2])])
    })
}

fn rgb16_on_white(img: &Rgba16Image) -> Rgb16Image {
    const M: u64 = u16::MAX as u64;
    Rgb16Image::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        let a = p[3] as u64;
        let c = |v: u16| ((v as u64 * a + M * (M - a) + M / 2) / M) as u16;
        ::image::Rgb([c(p[0]), c(p[1]), c(p[2])])
    })
}

/// Teto do buffer de 16 bits (RGBA16 = 8 bytes/pixel); acima disso o Salvar fica em 8 bits.
const MAX_DEEP_BYTES: u64 = super::decode::MAX_DECODE_BYTES as u64;

/// Primeiro quadro em RGBA16, já orientado, se o arquivo (PNG ou TIFF) tiver 16 bits por canal.
pub fn decode16(bytes: &[u8], format: SourceFormat) -> Option<Rgba16Image> {
    let fmt = match format {
        SourceFormat::Png => ImageFormat::Png,
        SourceFormat::Tiff => ImageFormat::Tiff,
        _ => return None,
    };
    // O arquivo já abriu antes; um pânico do decodificador aqui só desliga os 16 bits.
    std::panic::catch_unwind(|| {
        let mut dec = ImageReader::with_format(Cursor::new(bytes), fmt)
            .into_decoder()
            .ok()?;
        let deep = matches!(
            dec.color_type(),
            ColorType::L16 | ColorType::La16 | ColorType::Rgb16 | ColorType::Rgba16
        );
        let (w, h) = dec.dimensions();
        if !deep || w as u64 * h as u64 * 8 > MAX_DEEP_BYTES {
            return None;
        }
        let orientation = dec.orientation().unwrap_or(Orientation::NoTransforms);
        let mut img = DynamicImage::from_decoder(dec).ok()?;
        img.apply_orientation(orientation);
        Some(img.into_rgba16())
    })
    .ok()
    .flatten()
}

/// Os 16 bits são os mesmos pixels do documento (mesmo arquivo e orientação), a menos do
/// arredondamento para 8 bits.
pub fn matches8(deep: &Rgba16Image, px: &RgbaImage) -> bool {
    deep.dimensions() == px.dimensions()
        && deep
            .as_raw()
            .par_iter()
            .zip(px.as_raw().par_iter())
            .all(|(&a, &b)| (a as i32 / 257 - b as i32).abs() <= 1)
}

/// Aplica uma operação em 16 bits, com o mesmo resultado (a menos da precisão) de `ops::apply`.
pub fn apply16(img: &Rgba16Image, op: &Op) -> Rgba16Image {
    match op {
        Op::Rotate { quarter_turns } => match quarter_turns.rem_euclid(4) {
            1 => imageops::rotate90(img),
            2 => imageops::rotate180(img),
            3 => imageops::rotate270(img),
            _ => img.clone(),
        },
        Op::FlipH => imageops::flip_horizontal(img),
        Op::FlipV => imageops::flip_vertical(img),
        Op::Crop(c) => crop16(img, c),
        Op::Resize { w, h, filter, .. } => resize16(img, *w, *h, *filter),
        Op::Adjust(adj) => color::adjust16(img, adj),
        Op::Erase(mask) => masked16(img, mask, |p| *p = [0; 4]),
        Op::MakeTransparent(mask) => masked16(img, mask, |p| p[3] = 0),
        Op::Composite { png, .. } => composite16(img, png),
        Op::AssignProfile { .. } => img.clone(),
        Op::OnPage { op, .. } => apply16(img, op),
    }
}

fn crop16(img: &Rgba16Image, c: &CropSpec) -> Rgba16Image {
    let (w, h) = img.dimensions();
    let r = ops::clamp_rect(c.rect, w, h);
    let mut out = imageops::crop_imm(img, r.x, r.y, r.w, r.h).to_image();
    if let Some(mask) = &c.mask {
        let cov = ops::mask_coverage(mask, w, h);
        for (x, y, px) in out.enumerate_pixels_mut() {
            if !cov[((r.y + y) * w + r.x + x) as usize] {
                px.0[3] = 0;
            }
        }
    }
    out
}

fn resize16(img: &Rgba16Image, w: u32, h: u32, filter: ResizeFilter) -> Rgba16Image {
    use fast_image_resize::{ResizeOptions, Resizer};
    let mut out = Rgba16Image::new(w, h);
    Resizer::new()
        .resize(
            img,
            &mut out,
            &ResizeOptions::new().resize_alg(ops::resize_alg(filter)),
        )
        .expect("tipos de pixel iguais (U16x4)");
    out
}

fn masked16(img: &Rgba16Image, mask: &Mask, f: impl Fn(&mut [u16; 4]) + Sync) -> Rgba16Image {
    let (w, h) = img.dimensions();
    let cov = ops::mask_coverage(mask, w, h);
    let mut out = img.clone();
    out.par_chunks_exact_mut(4)
        .zip(cov.par_iter())
        .for_each(|(p, &inside)| {
            if inside {
                f(p.try_into().expect("4 canais"));
            }
        });
    out
}

/// Anotações (PNG RGBA de 8 bits) por cima, src-over em f32.
fn composite16(img: &Rgba16Image, png: &[u8]) -> Rgba16Image {
    let Ok(over) = ::image::load_from_memory_with_format(png, ImageFormat::Png) else {
        return img.clone();
    };
    let mut over = over.into_rgba8();
    if over.dimensions() != img.dimensions() {
        over = ops::resize(&over, img.width(), img.height(), ResizeFilter::Bilinear);
    }
    let mut out = img.clone();
    out.par_chunks_exact_mut(4)
        .zip(over.par_chunks_exact(4))
        .for_each(|(d, s)| {
            let sa = s[3] as f32 / 255.0;
            if sa == 0.0 {
                return;
            }
            let da = d[3] as f32 / 65535.0;
            let oa = sa + da * (1.0 - sa);
            for c in 0..3 {
                let v = (s[c] as f32 / 255.0 * sa + d[c] as f32 / 65535.0 * da * (1.0 - sa)) / oa;
                d[c] = (v * 65535.0).round().clamp(0.0, 65535.0) as u16;
            }
            d[3] = (oa * 65535.0).round() as u16;
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::model::Rect;
    use ::image::Rgba;

    fn img16() -> Rgba16Image {
        Rgba16Image::from_fn(9, 7, |x, y| Rgba([x as u16 * 7000, y as u16 * 9000, 1234, 65535]))
    }

    #[test]
    fn operacoes_em_16_bits_batem_com_as_de_8() {
        let a = img16();
        let a8 = DynamicImage::ImageRgba16(a.clone()).into_rgba8();
        let mask = Mask::Rect(Rect { x: 1, y: 1, w: 3, h: 2 });
        for op in [
            Op::Rotate { quarter_turns: 3 },
            Op::FlipV,
            Op::Crop(CropSpec { rect: Rect { x: 2, y: 1, w: 5, h: 4 }, mask: Some(mask.clone()) }),
            Op::Resize { w: 4, h: 3, filter: ResizeFilter::Bilinear, dpi: None },
            Op::Erase(mask.clone()),
            Op::MakeTransparent(mask),
        ] {
            let deep = DynamicImage::ImageRgba16(apply16(&a, &op)).into_rgba8();
            let flat = ops::apply(&a8, &op);
            assert_eq!(deep.dimensions(), flat.dimensions(), "{op:?}");
            for (p, q) in deep.pixels().zip(flat.pixels()) {
                for c in 0..4 {
                    assert!((p[c] as i32 - q[c] as i32).abs() <= 1, "{op:?}: {p:?} x {q:?}");
                }
            }
        }
    }

    #[test]
    fn anotacao_composta_em_16_bits() {
        let mut over = RgbaImage::new(9, 7);
        over.put_pixel(2, 2, Rgba([255, 0, 0, 255]));
        over.put_pixel(3, 3, Rgba([0, 0, 255, 128]));
        let mut png = Vec::new();
        over.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).unwrap();
        let out = apply16(&img16(), &Op::Composite { png: png.clone(), frame: None });
        assert_eq!(out.get_pixel(2, 2).0, [65535, 0, 0, 65535]);
        assert_eq!(out.get_pixel(0, 0), img16().get_pixel(0, 0));
        let flat = ops::apply(&DynamicImage::ImageRgba16(img16()).into_rgba8(), &Op::Composite { png, frame: None });
        let p = out.get_pixel(3, 3);
        let q = flat.get_pixel(3, 3);
        for c in 0..4 {
            assert!((p[c] as i32 / 257 - q[c] as i32).abs() <= 1, "{p:?} x {q:?}");
        }
    }

    #[test]
    fn so_aceita_arquivo_de_16_bits_que_bate() {
        let a = img16();
        let mut png = Vec::new();
        DynamicImage::ImageRgba16(a.clone())
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let d = decode16(&png, SourceFormat::Png).unwrap();
        assert_eq!(d, a);
        assert!(matches8(&d, &DynamicImage::ImageRgba16(a).into_rgba8()));
        assert!(!matches8(&d, &RgbaImage::new(9, 7)));
        let mut png8 = Vec::new();
        RgbaImage::new(4, 4).write_to(&mut Cursor::new(&mut png8), ImageFormat::Png).unwrap();
        assert_eq!(decode16(&png8, SourceFormat::Png), None);
        assert_eq!(decode16(b"lixo", SourceFormat::Png), None);
    }
}
