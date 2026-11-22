//! Paginação da impressão (Lote 11): o que cai em cada página e onde, em pontos (1/72"). Puro,
//! sem GTK: a prévia do diálogo e o desenho na impressora usam as mesmas contas.
use super::{ops, pdf::to_points, raster};
use crate::doc::model::ResizeFilter;
use ::image::{RgbaImage, imageops};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrintFit {
    /// Imprimir imagem inteira.
    Whole,
    /// Preencher o papel (corta o que sobrar).
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOptions {
    pub copies: u32,
    /// Escala em %; `None` = usar `fit`.
    pub scale_percent: Option<u32>,
    pub fit: PrintFit,
    pub auto_rotate: bool,
    /// Um de [`PER_PAGE`].
    pub per_page: u32,
    /// Nome PWG do papel (um de [`PAPERS`]).
    pub paper: String,
    pub orientation: Orientation,
}

/// Papéis oferecidos: nome PWG (o mesmo do GTK) e tamanho em mm.
pub const PAPERS: [(&str, f64, f64); 9] = [
    ("iso_a4", 210.0, 297.0),
    ("na_letter", 215.9, 279.4),
    ("na_legal", 215.9, 355.6),
    ("iso_a3", 297.0, 420.0),
    ("iso_a5", 148.0, 210.0),
    ("iso_a6", 105.0, 148.0),
    ("iso_b5", 176.0, 250.0),
    ("na_index-4x6", 101.6, 152.4),
    ("na_5x7", 127.0, 177.8),
];

/// Imagens por página, com a grade (lado menor × lado maior do papel).
pub const PER_PAGE: [(u32, (u32, u32)); 6] =
    [(1, (1, 1)), (2, (1, 2)), (4, (2, 2)), (6, (2, 3)), (9, (3, 3)), (16, (4, 4))];

/// Margens padrão do GTK: 1/4", e 0,56" embaixo nos papéis comuns em impressoras antigas.
const MARGIN: f64 = 18.0;
const MARGIN_BOTTOM: f64 = 0.56 * 72.0;
const BIG_BOTTOM: [&str; 3] = ["iso_a4", "na_letter", "na_legal"];
/// Espaço entre as imagens da mesma página.
const GAP: f64 = 9.0;
pub const MAX_COPIES: u32 = 999;
pub const MAX_SCALE: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct RectF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl RectF {
    fn intersect(self, o: RectF) -> RectF {
        let (x, y) = (self.x.max(o.x), self.y.max(o.y));
        let right = (self.x + self.w).min(o.x + o.w);
        let bottom = (self.y + self.h).min(o.y + o.h);
        RectF { x, y, w: (right - x).max(0.0), h: (bottom - y).max(0.0) }
    }
}

/// Uma imagem na página: `rect` é ela inteira (já girada) e `clip` a célula que a corta.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Placement {
    /// Girada 90° no sentido horário.
    pub rotated: bool,
    pub rect: RectF,
    pub clip: RectF,
}

/// Tamanho em pixels e resolução de uma imagem a imprimir.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub w: u32,
    pub h: u32,
    pub dpi: Option<(f32, f32)>,
}

impl PrintOptions {
    /// Puxa para valores aceitos o que veio da interface.
    pub fn sanitized(mut self) -> Self {
        self.copies = self.copies.clamp(1, MAX_COPIES);
        self.scale_percent = self.scale_percent.map(|s| s.clamp(1, MAX_SCALE));
        if !PER_PAGE.iter().any(|(n, _)| *n == self.per_page) {
            self.per_page = 1;
        }
        if !PAPERS.iter().any(|(n, ..)| *n == self.paper) {
            self.paper = PAPERS[0].0.to_string();
        }
        self
    }

    /// Papel em pontos, na orientação escolhida.
    pub fn paper_size(&self) -> (f64, f64) {
        let (_, w, h) = PAPERS.iter().find(|(n, ..)| *n == self.paper).unwrap_or(&PAPERS[0]);
        let pt = |mm: f64| mm / 25.4 * 72.0;
        match self.orientation {
            Orientation::Portrait => (pt(*w), pt(*h)),
            Orientation::Landscape => (pt(*h), pt(*w)),
        }
    }

    /// Preencher o papel usa a folha toda, sem margens.
    pub fn full_page(&self) -> bool {
        self.fit == PrintFit::Fill && self.scale_percent.is_none() && self.per_page == 1
    }

    /// Área usada do papel (a prévia usa as margens padrão; na impressão, vale a da impressora).
    pub fn printable(&self) -> RectF {
        let (w, h) = self.paper_size();
        if self.full_page() {
            return RectF { x: 0.0, y: 0.0, w, h };
        }
        let big = BIG_BOTTOM.contains(&self.paper.as_str());
        let bottom = if big { MARGIN_BOTTOM } else { MARGIN };
        // Na paisagem, o pé da folha fica à esquerda.
        match self.orientation {
            Orientation::Portrait => {
                RectF { x: MARGIN, y: MARGIN, w: w - 2.0 * MARGIN, h: h - MARGIN - bottom }
            }
            Orientation::Landscape => {
                RectF { x: bottom, y: MARGIN, w: w - MARGIN - bottom, h: h - 2.0 * MARGIN }
            }
        }
    }
}

/// Total de páginas. Uma imagem só se repete até encher a página; várias vão em sequência.
pub fn page_count(images: usize, per_page: u32) -> usize {
    images.div_ceil(per_page.max(1) as usize)
}

/// `(célula, imagem)` da página `page`.
pub fn page_items(images: usize, per_page: u32, page: usize) -> Vec<(usize, usize)> {
    let n = per_page.max(1) as usize;
    (0..n)
        .filter_map(|c| match page * n + c {
            _ if images == 1 && page == 0 => Some((c, 0)),
            i if i < images => Some((c, i)),
            _ => None,
        })
        .collect()
}

/// Célula `index` da página de área `area`.
pub fn cell(area: RectF, per_page: u32, index: usize) -> RectF {
    let (short, long) =
        PER_PAGE.iter().find(|(n, _)| *n == per_page).map_or((1, 1), |(_, grid)| *grid);
    let (cols, rows) = if area.w > area.h { (long, short) } else { (short, long) };
    let w = (area.w - GAP * (cols - 1) as f64) / cols as f64;
    let h = (area.h - GAP * (rows - 1) as f64) / rows as f64;
    let (col, row) = (index as u32 % cols, index as u32 / cols);
    RectF { x: area.x + col as f64 * (w + GAP), y: area.y + row as f64 * (h + GAP), w, h }
}

/// Posição da imagem na célula, centralizada.
pub fn place(img: Size, cell: RectF, opts: &PrintOptions) -> Placement {
    let rotated = opts.auto_rotate
        && img.w != img.h
        && cell.w != cell.h
        && (img.w > img.h) != (cell.w > cell.h);
    let natural = to_points((img.w, img.h), img.dpi);
    let (w, h) = if rotated { (natural.1, natural.0) } else { natural };
    let (kx, ky) = (cell.w / w, cell.h / h);
    let k = match (opts.scale_percent, opts.fit) {
        (Some(pct), _) => pct as f64 / 100.0,
        (None, PrintFit::Whole) => kx.min(ky),
        (None, PrintFit::Fill) => kx.max(ky),
    };
    let (w, h) = (w * k, h * k);
    Placement {
        rotated,
        rect: RectF {
            x: cell.x + (cell.w - w) / 2.0,
            y: cell.y + (cell.h - h) / 2.0,
            w,
            h,
        },
        clip: cell,
    }
}

/// Pixels prontos para o Cairo: RGB24 nativo (opaco, composto sobre branco) e o mesmo em JPEG,
/// que o PDF da impressão embute sem recomprimir na thread do GTK.
pub struct Bitmap {
    pub w: u32,
    pub h: u32,
    pub rgb24: Vec<u8>,
    pub jpeg: Vec<u8>,
    /// Onde entra na página (a parte visível).
    pub dest: RectF,
}

/// Resolução máxima mandada à impressora: acima disto a imagem é reduzida.
const MAX_PRINT_DPI: f64 = 600.0;
const PRINT_JPEG_QUALITY: u8 = 95;

/// Recorta, reduz e gira `px` (sRGB) para a posição `p`. `None` se nada aparece na página.
pub fn prepare(px: &RgbaImage, p: &Placement) -> Option<Bitmap> {
    let visible = p.rect.intersect(p.clip);
    if visible.w <= 0.0 || visible.h <= 0.0 {
        return None;
    }
    let (iw, ih) = px.dimensions();
    // Parte visível como fração da imagem girada e, desfeito o giro, da original.
    let (fx, fy) = ((visible.x - p.rect.x) / p.rect.w, (visible.y - p.rect.y) / p.rect.h);
    let (fw, fh) = (visible.w / p.rect.w, visible.h / p.rect.h);
    let (fx, fy, fw, fh) =
        if p.rotated { (fy, 1.0 - fx - fw, fh, fw) } else { (fx, fy, fw, fh) };
    let span = |from: f64, len: f64, total: u32| {
        let a = ((from * total as f64).round() as u32).min(total - 1);
        (a, ((len * total as f64).round() as u32).clamp(1, total - a))
    };
    let ((x, w), (y, h)) = (span(fx, fw, iw), span(fy, fh, ih));
    let crop = if (w, h) == (iw, ih) {
        Cow::Borrowed(px)
    } else {
        Cow::Owned(imageops::crop_imm(px, x, y, w, h).to_image())
    };
    let (dw, dh) = if p.rotated { (visible.h, visible.w) } else { (visible.w, visible.h) };
    let cap = |points: f64| (points / 72.0 * MAX_PRINT_DPI).ceil().max(1.0);
    let k = (cap(dw) / w as f64).min(cap(dh) / h as f64);
    let small = if k < 1.0 {
        let side = |v: u32| ((v as f64 * k).round() as u32).max(1);
        Cow::Owned(ops::resize(&crop, side(w), side(h), ResizeFilter::Lanczos3))
    } else {
        crop
    };
    let img = if p.rotated { Cow::Owned(imageops::rotate90(&*small)) } else { small };
    let (w, h) = img.dimensions();
    let rgb = raster::rgb_on_white(&img);
    drop(img);
    let mut jpeg = Vec::new();
    ::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, PRINT_JPEG_QUALITY)
        .encode_image(&rgb)
        .ok()?;
    // RGB24 do Cairo: inteiros nativos de 32 bits 0x00RRGGBB (o passo é sempre 4 × largura).
    let rgb24 = rgb
        .pixels()
        .flat_map(|p| u32::from_be_bytes([0, p[0], p[1], p[2]]).to_ne_bytes())
        .collect();
    Some(Bitmap { w, h, rgb24, jpeg, dest: visible })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::image::Rgba;

    fn opts() -> PrintOptions {
        PrintOptions {
            copies: 1,
            scale_percent: None,
            fit: PrintFit::Whole,
            auto_rotate: true,
            per_page: 1,
            paper: "iso_a4".into(),
            orientation: Orientation::Portrait,
        }
    }

    const AREA: RectF = RectF { x: 10.0, y: 20.0, w: 400.0, h: 600.0 };

    fn size(w: u32, h: u32) -> Size {
        Size { w, h, dpi: None }
    }

    #[track_caller]
    fn near(a: RectF, b: (f64, f64, f64, f64)) {
        let d = [a.x - b.0, a.y - b.1, a.w - b.2, a.h - b.3];
        assert!(d.iter().all(|v| v.abs() < 0.01), "{a:?} != {b:?}");
    }

    #[test]
    fn imagem_inteira_cabe_e_centraliza() {
        let p = place(size(200, 200), AREA, &opts());
        assert!(!p.rotated);
        near(p.rect, (10.0, 120.0, 400.0, 400.0));
        // Amplia até encostar na área, como no Pré-Visualização.
        near(place(size(2, 3), AREA, &opts()).rect, (10.0, 20.0, 400.0, 600.0));
    }

    #[test]
    fn preencher_cobre_a_celula_e_corta() {
        let o = PrintOptions { fit: PrintFit::Fill, ..opts() };
        let p = place(size(200, 200), AREA, &o);
        near(p.rect, (-90.0, 20.0, 600.0, 600.0));
        assert_eq!(p.clip, AREA);
    }

    #[test]
    fn girar_automaticamente_so_se_a_orientacao_difere() {
        let p = place(size(600, 400), AREA, &opts());
        assert!(p.rotated);
        near(p.rect, (10.0, 20.0, 400.0, 600.0));
        assert!(!place(size(400, 600), AREA, &opts()).rotated);
        assert!(!place(size(500, 500), AREA, &opts()).rotated);
        let off = PrintOptions { auto_rotate: false, ..opts() };
        let p = place(size(600, 400), AREA, &off);
        assert!(!p.rotated);
        near(p.rect, (10.0, 186.667, 400.0, 266.667));
    }

    #[test]
    fn escala_em_porcentagem_do_tamanho_natural() {
        let o = PrintOptions { scale_percent: Some(50), auto_rotate: false, ..opts() };
        // 300 px a 150 ppp = 144 pontos; 50% = 72.
        let img = Size { w: 300, h: 150, dpi: Some((150.0, 150.0)) };
        near(place(img, AREA, &o).rect, (174.0, 302.0, 72.0, 36.0));
        // Sem ppp, 72; com ppp inválido também.
        assert_eq!(place(size(100, 100), AREA, &o).rect.w, 50.0);
        let bad = Size { w: 100, h: 100, dpi: Some((0.0, 0.0)) };
        assert_eq!(place(bad, AREA, &o).rect.w, 50.0);
        for d in [0.01, 1e9, f32::INFINITY, f32::NAN] {
            let r = place(Size { w: 100, h: 50, dpi: Some((d, 150.0)) }, AREA, &o).rect;
            assert_eq!((r.w, r.h), (50.0, 25.0), "{d}");
        }
    }

    #[test]
    fn grade_segue_a_orientacao_da_pagina() {
        let wide = RectF { x: 0.0, y: 0.0, w: 600.0, h: 400.0 };
        let tall = RectF { x: 0.0, y: 0.0, w: 400.0, h: 600.0 };
        // 2 por página: empilhadas no retrato, lado a lado na paisagem.
        near(cell(tall, 2, 1), (0.0, 304.5, 400.0, 295.5));
        near(cell(wide, 2, 1), (304.5, 0.0, 295.5, 400.0));
        for (n, _) in PER_PAGE {
            for area in [wide, tall] {
                for i in 0..n as usize {
                    let c = cell(area, n, i);
                    assert!(c.x >= 0.0 && c.y >= 0.0);
                    assert!(c.x + c.w <= area.w + 0.01 && c.y + c.h <= area.h + 0.01);
                    for j in 0..i {
                        let x = c.intersect(cell(area, n, j));
                        assert!(x.w <= 0.01 || x.h <= 0.01, "{n}: {i} e {j} se sobrepõem");
                    }
                }
            }
        }
    }

    #[test]
    fn paginas_e_sequencia() {
        assert_eq!(page_count(5, 2), 3);
        assert_eq!(page_items(5, 2, 1), [(0, 2), (1, 3)]);
        assert_eq!(page_items(5, 2, 2), [(0, 4)]);
        // Uma imagem só: repetida até encher a página.
        assert_eq!(page_count(1, 4), 1);
        assert_eq!(page_items(1, 4, 0), [(0, 0), (1, 0), (2, 0), (3, 0)]);
        assert_eq!(page_count(0, 4), 0);
    }

    #[test]
    fn opcoes_invalidas_sao_puxadas_para_o_aceito() {
        let o = PrintOptions {
            copies: 0,
            scale_percent: Some(0),
            per_page: 7,
            paper: "../../etc".into(),
            ..opts()
        }
        .sanitized();
        let got = (o.copies, o.scale_percent, o.per_page, o.paper.as_str());
        assert_eq!(got, (1, Some(1), 1, "iso_a4"));
    }

    #[test]
    fn papel_orientacao_e_margens() {
        let (w, h) = opts().paper_size();
        assert!((w - 595.28).abs() < 0.01 && (h - 841.89).abs() < 0.01);
        near(opts().printable(), (18.0, 18.0, w - 36.0, h - 58.32));
        let a5 = PrintOptions { paper: "iso_a5".into(), ..opts() };
        assert!((a5.printable().h - (a5.paper_size().1 - 36.0)).abs() < 0.01);
        let fill = PrintOptions { fit: PrintFit::Fill, ..opts() };
        near(fill.printable(), (0.0, 0.0, w, h));
        assert!(!PrintOptions { per_page: 2, ..fill.clone() }.full_page());
        assert!(!PrintOptions { scale_percent: Some(100), ..fill }.full_page());
        let l = PrintOptions { orientation: Orientation::Landscape, ..opts() };
        assert!((l.paper_size().0 - 841.89).abs() < 0.01);
        near(l.printable(), (40.32, 18.0, h - 58.32, w - 36.0));
    }

    /// Imagem 4×2 com cada pixel de uma cor (o vermelho codifica a posição).
    fn marked() -> RgbaImage {
        RgbaImage::from_fn(4, 2, |x, y| Rgba([(x + 4 * y) as u8 * 30, 0, 0, 255]))
    }

    fn prep(rotated: bool, rect: RectF, clip: RectF) -> Option<Bitmap> {
        prepare(&marked(), &Placement { rotated, rect, clip })
    }

    fn reds(b: &Bitmap) -> Vec<u8> {
        let px = b.rgb24.chunks(4);
        px.map(|c| (u32::from_ne_bytes(c.try_into().unwrap()) >> 16) as u8).collect()
    }

    #[test]
    fn prepara_inteira_girada_e_cortada() {
        let r = RectF { x: 0.0, y: 0.0, w: 40.0, h: 20.0 };
        let b = prep(false, r, r).unwrap();
        assert_eq!((b.w, b.h, b.dest), (4, 2, r));
        assert_eq!(reds(&b), [0, 30, 60, 90, 120, 150, 180, 210]);

        let t = RectF { x: 0.0, y: 0.0, w: 20.0, h: 40.0 };
        let b = prep(true, t, t).unwrap();
        assert_eq!((b.w, b.h), (2, 4));
        assert_eq!(reds(&b), [120, 0, 150, 30, 180, 60, 210, 90], "90° no sentido horário");

        // Célula que mostra só a metade esquerda, sem e com giro.
        let b = prep(false, r, RectF { w: 20.0, ..r }).unwrap();
        assert_eq!((b.w, b.h, b.dest.w), (2, 2, 20.0));
        assert_eq!(reds(&b), [0, 30, 120, 150]);
        let b = prep(true, t, RectF { w: 10.0, ..t }).unwrap();
        assert_eq!((b.w, b.h), (1, 4));
        assert_eq!(reds(&b), [120, 150, 180, 210]);
        assert!(prep(false, r, RectF { x: 50.0, ..r }).is_none());
    }

    #[test]
    fn reduz_o_excesso_e_compoe_o_alfa_sobre_branco() {
        let img = RgbaImage::from_pixel(2400, 1200, Rgba([0, 0, 0, 0]));
        let r = RectF { x: 0.0, y: 0.0, w: 72.0, h: 36.0 };
        let b = prepare(&img, &Placement { rotated: false, rect: r, clip: r }).unwrap();
        assert_eq!((b.w, b.h), (600, 300));
        assert_eq!(&b.rgb24[..4], &0x00FF_FFFFu32.to_ne_bytes());
        assert!(b.jpeg.starts_with(&[0xFF, 0xD8]));
    }
}
