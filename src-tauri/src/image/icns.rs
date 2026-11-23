//! Ícones do macOS (`.icns`): abre só o maior, como uma imagem. Guarda PNG ou JPEG 2000 (os
//! grandes), ARGB com RLE por canal ou RGB com RLE e máscara separada (os clássicos).
use super::decode::{self, Decoded};
use crate::{
    doc::model::SourceFormat,
    error::{AppError, AppResult},
};
use ::image::RgbaImage;
use std::path::Path;

/// Maior lado aceito dentro de um ícone (o formato vai até 1024).
const MAX_SIDE: usize = 2048;
/// Elementos lidos de um arquivo (um ícone real tem perto de 20).
const MAX_ELEMENTS: usize = 256;
/// Ícones tentados, do maior para o menor: cada quebrado custa uma decodificação.
const MAX_TRIES: usize = 3;

/// Lado em pixels e, nos clássicos de 24 bits, o tipo da máscara. `None` = não é imagem colorida.
fn side_of(kind: &[u8]) -> Option<(usize, Option<&'static [u8; 4]>)> {
    Some(match kind {
        b"icp4" | b"ic04" => (16, None),
        b"icsb" => (18, None),
        b"sb24" => (24, None),
        b"icp5" | b"ic05" | b"ic11" => (32, None),
        b"icsB" => (36, None),
        b"SB24" => (48, None),
        b"icp6" | b"ic12" => (64, None),
        b"ic07" => (128, None),
        b"ic08" | b"ic13" => (256, None),
        b"ic09" | b"ic14" => (512, None),
        b"ic10" => (1024, None),
        b"is32" => (16, Some(b"s8mk")),
        b"il32" => (32, Some(b"l8mk")),
        b"ih32" => (48, Some(b"h8mk")),
        b"it32" => (128, Some(b"t8mk")),
        _ => return None,
    })
}

/// `(tipo, dados)` de cada elemento; um tamanho impossível encerra a lista.
fn elements(bytes: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut out = Vec::new();
    let mut rest = bytes.get(8..).unwrap_or_default();
    while out.len() < MAX_ELEMENTS
        && let Some((head, body)) = rest.split_first_chunk::<8>()
    {
        let len = u32::from_be_bytes([head[4], head[5], head[6], head[7]]) as usize;
        let Some(n) = len.checked_sub(8).filter(|&n| n <= body.len()) else {
            break;
        };
        out.push((&rest[..4], &body[..n]));
        rest = &body[n..];
    }
    out
}

pub fn decode(bytes: &[u8]) -> AppResult<Decoded> {
    let all = elements(bytes);
    let mut icons: Vec<_> = all
        .iter()
        .filter_map(|&(kind, data)| side_of(kind).map(|(side, mask)| (side, mask, data)))
        .collect();
    icons.sort_by_key(|&(side, ..)| std::cmp::Reverse(side));
    icons
        .into_iter()
        .take(MAX_TRIES)
        .find_map(|(side, mask, data)| match mask {
            None => embedded(data).or_else(|| argb(data, side)),
            Some(m) => {
                let mask = all.iter().find(|(kind, _)| *kind == m).map(|&(_, d)| d);
                rgb24(data, mask, side)
            }
        })
        .map(|d| Decoded { format: SourceFormat::Icns, ..d })
        .ok_or_else(|| AppError::Corrupt("ICNS sem ícone legível".into()))
}

/// PNG ou JPEG 2000 embutido, com o perfil que trouxer.
fn embedded(data: &[u8]) -> Option<Decoded> {
    let png = data.starts_with(b"\x89PNG\r\n\x1a\n");
    if !png && !data.starts_with(b"\0\0\0\x0cjP  ") && !data.starts_with(&[0xFF, 0x4F, 0xFF, 0x51]) {
        return None;
    }
    let size = imagesize::blob_size(data).ok();
    if size.is_some_and(|s| s.width > MAX_SIDE || s.height > MAX_SIDE) || (png && size.is_none()) {
        return None;
    }
    let d = decode::decode_bytes(Path::new(""), data).ok()?;
    let (w, h) = d.frames.first()?.dimensions();
    (w as usize <= MAX_SIDE && h as usize <= MAX_SIDE).then_some(d)
}

fn argb(data: &[u8], side: usize) -> Option<Decoded> {
    let n = side * side;
    let planes = unpack(data.strip_prefix(b"ARGB")?, n * 4)?;
    image(side, |i| [planes[n + i], planes[2 * n + i], planes[3 * n + i], planes[i]])
}

/// 24 bits com RLE (ou crus, quando já têm o tamanho certo) e máscara de 8 bits opcional.
fn rgb24(data: &[u8], mask: Option<&[u8]>, side: usize) -> Option<Decoded> {
    let n = side * side;
    // O de 128 px começa com quatro zeros.
    let data = if side == 128 { data.strip_prefix(&[0; 4]).unwrap_or(data) } else { data };
    let planes = if data.len() == n * 3 { data.to_vec() } else { unpack(data, n * 3)? };
    let mask = mask.filter(|m| m.len() >= n);
    image(side, |i| [planes[i], planes[n + i], planes[2 * n + i], mask.map_or(255, |m| m[i])])
}

fn image(side: usize, at: impl Fn(usize) -> [u8; 4]) -> Option<Decoded> {
    let px = (0..side * side).flat_map(at).collect();
    let img = RgbaImage::from_raw(side as u32, side as u32, px)?;
    Some(Decoded::single(img, SourceFormat::Icns))
}

/// RLE do ICNS: até 0x7F, `n + 1` bytes literais; acima, o byte seguinte repetido `n - 125` vezes.
fn unpack(mut data: &[u8], want: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(want);
    while out.len() < want {
        let (&n, rest) = data.split_first()?;
        if n < 0x80 {
            let (lit, rest) = rest.split_at_checked(n as usize + 1)?;
            out.extend_from_slice(lit);
            data = rest;
        } else {
            let (&v, rest) = rest.split_first()?;
            out.resize(out.len() + n as usize - 125, v);
            data = rest;
        }
    }
    out.truncate(want);
    Some(out)
}
