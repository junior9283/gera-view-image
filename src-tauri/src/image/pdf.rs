//! PDF de imagens (Lote 11): uma página por imagem, do tamanho dela na resolução pedida. Os
//! pixels chegam em sRGB e o perfil sRGB vai embutido (`ICCBased`); a transparência vira `SMask`.
use super::icc;
use crate::error::{AppError, AppResult};
use ::image::{DynamicImage, codecs::jpeg::JpegEncoder};
use flate2::{Compression, write::ZlibEncoder};
use rayon::prelude::*;
use std::{borrow::Cow, io::Write};

/// Resolução de uma imagem sem ppp (como no Pré-Visualização: 1 px = 1 ponto).
pub const DEFAULT_DPI: f32 = 72.0;
/// Lado máximo de uma página no PDF (200 polegadas).
const MAX_PAGE: f64 = 14_400.0;
/// Objetos fixos; os das páginas vêm depois.
const CATALOG: usize = 1;
const PAGES: usize = 2;
const ICC: usize = 3;

pub struct Pdf {
    out: Vec<u8>,
    /// Posição de cada objeto (índice = número − 1).
    offsets: Vec<usize>,
    pages: Vec<usize>,
}

impl Default for Pdf {
    fn default() -> Self {
        Self::new()
    }
}

/// Pixels em pontos (1/72"); sem ppp (ou inválido), 72.
pub fn to_points(px: u32, dpi: Option<f32>) -> f64 {
    px as f64 * 72.0 / dpi.filter(|d| *d > 0.0).unwrap_or(DEFAULT_DPI) as f64
}

/// Tamanho da página em pontos, dentro do limite do formato.
fn page_size((w, h): (u32, u32), dpi: Option<(f32, f32)>) -> (f64, f64) {
    let (w, h) = (to_points(w, dpi.map(|d| d.0)), to_points(h, dpi.map(|d| d.1)));
    let k = (MAX_PAGE / w.max(h)).min(1.0);
    (w * k, h * k)
}

impl Pdf {
    pub fn new() -> Self {
        let mut pdf = Pdf {
            // O comentário binário avisa que o arquivo não é texto.
            out: b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec(),
            offsets: vec![0; ICC],
            pages: Vec::new(),
        };
        pdf.stream(ICC, "/N 3 /Alternate /DeviceRGB /Filter /FlateDecode", &zlib(icc::srgb_icc()));
        pdf
    }

    fn new_id(&mut self) -> usize {
        self.offsets.push(0);
        self.offsets.len()
    }

    fn object(&mut self, id: usize, body: &str) {
        self.offsets[id - 1] = self.out.len();
        self.out
            .extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
    }

    fn stream(&mut self, id: usize, dict: &str, data: &[u8]) {
        self.offsets[id - 1] = self.out.len();
        let head = format!("{id} 0 obj\n<< {dict} /Length {} >>\nstream\n", data.len());
        self.out.extend_from_slice(head.as_bytes());
        self.out.extend_from_slice(data);
        self.out.extend_from_slice(b"\nendstream\nendobj\n");
    }

    /// Página com `px` (sRGB, 8 bits, com ou sem alfa). `quality`: JPEG; `None`: sem perdas.
    pub fn add_page(
        &mut self,
        px: &DynamicImage,
        quality: Option<u8>,
        dpi: Option<(f32, f32)>,
    ) -> AppResult<()> {
        let (w, h) = (px.width(), px.height());
        let (pw, ph) = page_size((w, h), dpi);
        let rgb = match px {
            DynamicImage::ImageRgb8(i) => Cow::Borrowed(i),
            other => Cow::Owned(other.to_rgb8()),
        };
        let size =
            format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /BitsPerComponent 8");
        let smask = match px {
            DynamicImage::ImageRgba8(i) => {
                let alpha: Vec<u8> = i.as_raw().par_chunks_exact(4).map(|p| p[3]).collect();
                let id = self.new_id();
                let dict = format!("{size} /ColorSpace /DeviceGray /Filter /FlateDecode");
                self.stream(id, &dict, &zlib(&alpha));
                format!(" /SMask {id} 0 R")
            }
            _ => String::new(),
        };
        let (filter, data) = match quality {
            Some(q) => {
                let mut jpg = Vec::new();
                JpegEncoder::new_with_quality(&mut jpg, q.clamp(1, 100))
                    .encode_image(&*rgb)
                    .map_err(|e| AppError::Io(format!("falha ao codificar: {e}")))?;
                ("/Filter /DCTDecode".to_string(), jpg)
            }
            None => {
                // Preditor TIFF (diferença horizontal): fotos comprimem bem melhor.
                let parms = format!(
                    "/Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 3 /Columns {w} >>"
                );
                (parms, zlib(&horizontal_diff(rgb.into_owned().into_raw(), w as usize * 3)))
            }
        };
        let image = self.new_id();
        let dict = format!("{size} /ColorSpace [/ICCBased {ICC} 0 R] {filter}{smask}");
        self.stream(image, &dict, &data);
        let content = self.new_id();
        self.stream(content, "", format!("q {pw:.4} 0 0 {ph:.4} 0 0 cm /Im Do Q").as_bytes());
        let page = self.new_id();
        self.object(
            page,
            &format!(
                "<< /Type /Page /Parent {PAGES} 0 R /MediaBox [0 0 {pw:.4} {ph:.4}] \
                 /Resources << /XObject << /Im {image} 0 R >> >> /Contents {content} 0 R >>"
            ),
        );
        self.pages.push(page);
        Ok(())
    }

    pub fn finish(mut self) -> Vec<u8> {
        let kids: Vec<String> = self.pages.iter().map(|p| format!("{p} 0 R")).collect();
        let tree = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len());
        self.object(PAGES, &tree);
        self.object(CATALOG, &format!("<< /Type /Catalog /Pages {PAGES} 0 R >>"));
        let xref = self.out.len();
        let n = self.offsets.len() + 1;
        let mut tail = format!("xref\n0 {n}\n0000000000 65535 f \n");
        for o in &self.offsets {
            tail.push_str(&format!("{o:010} 00000 n \n"));
        }
        tail.push_str(&format!(
            "trailer\n<< /Size {n} /Root {CATALOG} 0 R >>\nstartxref\n{xref}\n%%EOF\n"
        ));
        self.out.extend_from_slice(tail.as_bytes());
        self.out
    }
}

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut e = ZlibEncoder::new(Vec::with_capacity(data.len() / 2), Compression::default());
    e.write_all(data)
        .and_then(|()| e.finish())
        .expect("gravação em memória")
}

/// Cada amostra menos a do pixel à esquerda (3 canais de 8 bits por pixel).
fn horizontal_diff(mut rgb: Vec<u8>, stride: usize) -> Vec<u8> {
    rgb.par_chunks_exact_mut(stride).for_each(|row| {
        for i in (3..row.len()).rev() {
            row[i] = row[i].wrapping_sub(row[i - 3]);
        }
    });
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::test_util::{foto, gradiente, psnr};

    fn text(b: &[u8]) -> String {
        b.iter().map(|&c| c as char).collect()
    }

    /// Dados do primeiro stream de imagem RGB.
    fn image_stream(pdf: &[u8]) -> &[u8] {
        let find = |from: usize, pat: &[u8]| {
            from + pdf[from..].windows(pat.len()).position(|w| w == pat).expect("trecho do PDF")
        };
        let len_at = find(find(0, b"/ColorSpace [/ICCBased"), b"/Length ") + 8;
        let digits = pdf[len_at..].iter().take_while(|c| c.is_ascii_digit()).count();
        let len: usize = text(&pdf[len_at..len_at + digits]).parse().unwrap();
        let start = len_at + digits + b" >>\nstream\n".len();
        &pdf[start..start + len]
    }

    #[test]
    fn sem_perdas_guarda_os_pixels() {
        let img = gradiente(37, 11);
        let mut pdf = Pdf::new();
        pdf.add_page(&DynamicImage::ImageRgb8(img.clone()), None, None).unwrap();
        let out = pdf.finish();
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::ZlibDecoder::new(image_stream(&out)), &mut raw)
            .unwrap();
        for row in raw.chunks_mut(37 * 3) {
            for i in 3..row.len() {
                row[i] = row[i].wrapping_add(row[i - 3]);
            }
        }
        assert_eq!(&raw, img.as_raw());
        assert!(!text(&out).contains("SMask"), "opaca não leva máscara");
    }

    #[test]
    fn com_qualidade_embute_jpeg() {
        let img = DynamicImage::ImageRgb8(foto(80, 60));
        let mut pdf = Pdf::new();
        pdf.add_page(&img, Some(95), None).unwrap();
        let out = pdf.finish();
        let jpg = ::image::load_from_memory(image_stream(&out)).unwrap();
        let p = psnr(&img.to_rgba8(), &jpg.to_rgba8());
        assert!(p > 28.0, "PSNR {p}");
    }

    #[test]
    fn pagina_do_tamanho_da_imagem_na_resolucao() {
        assert_eq!(page_size((600, 300), None), (600.0, 300.0));
        assert_eq!(page_size((600, 300), Some((300.0, 300.0))), (144.0, 72.0));
        assert_eq!(page_size((600, 300), Some((0.0, -1.0))), (600.0, 300.0));
        assert_eq!(page_size((28_800, 7200), None), (14_400.0, 3600.0), "limitada a 200 polegadas");
    }

    /// As posições da xref apontam para os objetos e o alfa vira SMask em cinza.
    #[test]
    fn varias_paginas_xref_e_mascara() {
        let mut pdf = Pdf::new();
        let mut rgba = DynamicImage::ImageRgb8(gradiente(8, 8)).into_rgba8();
        rgba.get_pixel_mut(0, 0)[3] = 0;
        pdf.add_page(&DynamicImage::ImageRgba8(rgba), None, None).unwrap();
        pdf.add_page(&DynamicImage::ImageRgb8(gradiente(4, 2)), Some(90), None).unwrap();
        let out = pdf.finish();
        let t = text(&out);
        assert!(t.contains("/Count 2"));
        assert_eq!(t.matches("/SMask ").count(), 1);
        let tail = t.rsplit("startxref\n").next().unwrap();
        let xref: usize = tail.lines().next().unwrap().parse().unwrap();
        assert!(out[xref..].starts_with(b"xref\n"));
        let table = text(&out[xref..]);
        let rows: Vec<_> = table.lines().skip(3).take_while(|l| l.ends_with("n ")).collect();
        assert!(rows.len() >= 10);
        for (i, line) in rows.iter().enumerate() {
            let at: usize = line[..10].parse().unwrap();
            assert!(out[at..].starts_with(format!("{} 0 obj", i + 1).as_bytes()), "objeto {}", i + 1);
        }
    }
}
