//! MakerNote (aba do fabricante) e dados da lente do Inspetor (Lote 9).
//!
//! O MakerNote é um blob proprietário dentro do EXIF, escrito por quem fez o arquivo: tratamos
//! como bytes hostis. Cada fabricante tem um cabeçalho próprio e, depois dele, um IFD no estilo
//! TIFF. Lemos um único IFD por fabricante (sem seguir sub-IFDs nem o próximo IFD, então não há
//! ciclo possível), com teto de entradas e de bytes, e só `get` nas fatias.
use super::formatinfo::{Rows, sanitize};
use exif::{Exif, In, Tag, Value};
use std::fmt::Write as _;

/// Teto de entradas lidas do IFD do fabricante.
const MAX_ENTRIES: usize = 512;
/// Teto de valores numéricos mostrados por tag.
const MAX_VALUES: usize = 16;
/// Teto de bytes de um valor aceito (um MakerNote é pequeno; blobs de prévia não interessam).
const MAX_VALUE_BYTES: usize = 1 << 16;

/// Aba do fabricante: `name` é o nome legível (`Canon`, `Nikon`...).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Maker {
    pub name: String,
    pub rows: Rows,
}

#[derive(Clone, Copy)]
pub(super) struct Entry<'a> {
    pub tag: u16,
    pub ty: u16,
    pub count: usize,
    pub data: &'a [u8],
    pub le: bool,
}

/// Onde está o IFD do fabricante e como resolver os deslocamentos dos valores.
struct Layout<'a> {
    /// Buffer em que os deslocamentos dos valores são resolvidos.
    buf: &'a [u8],
    /// Soma aplicada a cada deslocamento (início do TIFF embutido, ou 0).
    base: usize,
    /// Posição do IFD em `buf`.
    ifd: usize,
    le: bool,
    name: &'static str,
    labels: fn(u16) -> Option<&'static str>,
}

pub(super) fn u16_at(b: &[u8], o: usize, le: bool) -> Option<u16> {
    let a: [u8; 2] = b.get(o..o.checked_add(2)?)?.try_into().ok()?;
    Some(if le { u16::from_le_bytes(a) } else { u16::from_be_bytes(a) })
}

fn u32_at(b: &[u8], o: usize, le: bool) -> Option<u32> {
    let a: [u8; 4] = b.get(o..o.checked_add(4)?)?.try_into().ok()?;
    Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
}

/// Tamanho em bytes de um elemento de cada tipo TIFF.
fn type_size(ty: u16) -> Option<usize> {
    Some(match ty {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => return None,
    })
}

/// Cabeçalho TIFF de `buf`: `(deslocamento do IFD0, little-endian?)`.
pub(super) fn tiff_header(buf: &[u8]) -> Option<(usize, bool)> {
    let le = match buf.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    Some((u32_at(buf, 4, le)? as usize, le))
}

/// Entradas do IFD em `ifd` (deslocamentos relativos a `buf`), com os mesmos tetos do MakerNote:
/// entradas, bytes por valor e fatias só dentro do buffer. Valores grandes demais são pulados
/// pelo cabeçalho de 12 bytes, sem ler o conteúdo.
pub(super) fn ifd_entries(buf: &[u8], ifd: usize, le: bool) -> Vec<Entry<'_>> {
    read_ifd(&Layout { buf, base: 0, ifd, le, name: "", labels: |_| None })
}


fn read_ifd<'a>(l: &Layout<'a>) -> Vec<Entry<'a>> {
    let mut out = Vec::new();
    let Some(n) = u16_at(l.buf, l.ifd, l.le) else {
        return out;
    };
    for i in 0..usize::from(n).min(MAX_ENTRIES) {
        let e = l.ifd + 2 + i * 12;
        let (Some(tag), Some(ty), Some(count)) = (
            u16_at(l.buf, e, l.le),
            u16_at(l.buf, e + 2, l.le),
            u32_at(l.buf, e + 4, l.le),
        ) else {
            break;
        };
        let Some(unit) = type_size(ty) else { continue };
        let Some(len) = unit.checked_mul(count as usize).filter(|&n| n <= MAX_VALUE_BYTES) else {
            continue;
        };
        let data = if len <= 4 {
            l.buf.get(e + 8..e + 8 + len)
        } else {
            u32_at(l.buf, e + 8, l.le)
                .and_then(|off| l.base.checked_add(off as usize))
                .and_then(|o| l.buf.get(o..o.checked_add(len)?))
        };
        if let Some(data) = data {
            out.push(Entry {
                tag,
                ty,
                count: count as usize,
                data,
                le: l.le,
            });
        }
    }
    out
}

/// Valor para exibir: texto, ou até `MAX_VALUES` números. `None` para blobs (`UNDEFINED`).
fn show(e: &Entry) -> Option<String> {
    let le = e.le;
    let vals = e.count.min(MAX_VALUES);
    match e.ty {
        2 => {
            let end = e.data.iter().position(|&b| b == 0).unwrap_or(e.data.len());
            let s = sanitize(&String::from_utf8_lossy(&e.data[..end]));
            (!s.is_empty()).then_some(s)
        }
        1 => Some(join(e.data.iter().take(vals).map(u8::to_string))),
        6 => Some(join(e.data.iter().take(vals).map(|&b| (b as i8).to_string()))),
        3 => Some(join((0..vals).filter_map(|i| u16_at(e.data, i * 2, le)).map(|v| v.to_string()))),
        8 => Some(join((0..vals).filter_map(|i| u16_at(e.data, i * 2, le)).map(|v| (v as i16).to_string()))),
        4 => Some(join((0..vals).filter_map(|i| u32_at(e.data, i * 4, le)).map(|v| v.to_string()))),
        9 => Some(join((0..vals).filter_map(|i| u32_at(e.data, i * 4, le)).map(|v| (v as i32).to_string()))),
        5 | 10 => Some(join((0..vals).filter_map(|i| {
            let (n, d) = (u32_at(e.data, i * 8, le)?, u32_at(e.data, i * 8 + 4, le)?);
            Some(if e.ty == 5 {
                ratio(f64::from(n), f64::from(d))
            } else {
                ratio(f64::from(n as i32), f64::from(d as i32))
            })
        }))),
        _ => None,
    }
}

fn join(it: impl Iterator<Item = String>) -> String {
    it.collect::<Vec<_>>().join(" ")
}

fn ratio(n: f64, d: f64) -> String {
    if d == 0.0 {
        return "—".to_string();
    }
    let v = n / d;
    let mut s = String::new();
    let _ = write!(s, "{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn rows_of(l: &Layout) -> Rows {
    read_ifd(l)
        .iter()
        .filter_map(|e| Some(((l.labels)(e.tag)?.to_string(), show(e)?)))
        .collect()
}

// ---------- Tabelas de tags (só as que têm significado direto) ----------

fn canon(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x06 => "Image Type",
        0x07 => "Firmware Version",
        0x08 => "File Number",
        0x09 => "Owner Name",
        0x0C => "Serial Number",
        0x10 => "Model ID",
        0x15 => "Serial Number Format",
        0x95 => "Lens Model",
        0x96 => "Internal Serial Number",
        0xAA => "Measured Color",
        _ => return None,
    })
}

fn nikon(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x02 => "ISO",
        0x04 => "Quality",
        0x05 => "White Balance",
        0x06 => "Sharpening",
        0x07 => "Focus Mode",
        0x08 => "Flash Setting",
        0x0F => "ISO Selection",
        0x1D => "Serial Number",
        0x1E => "Color Space",
        0x84 => "Lens (min/max focal length, min/max aperture)",
        0x92 => "Hue Adjustment",
        0x95 => "Noise Reduction",
        0xA7 => "Shutter Count",
        _ => return None,
    })
}

fn sony(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x0102 => "Quality",
        0x0104 => "Flash Exposure Compensation",
        0x0105 => "Teleconverter",
        0x0112 => "White Balance Fine Tune",
        0xB001 => "Model ID",
        0xB020 => "Creative Style",
        0xB021 => "Color Temperature",
        0xB023 => "Scene Mode",
        0xB025 => "Dynamic Range Optimizer",
        0xB026 => "Image Stabilization",
        _ => return None,
    })
}

fn fuji(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x1000 => "Quality",
        0x1001 => "Sharpness",
        0x1002 => "White Balance",
        0x1003 => "Saturation",
        0x1004 => "Contrast",
        0x1010 => "Flash Mode",
        0x1021 => "Focus Mode",
        0x1030 => "Slow Sync",
        0x1031 => "Picture Mode",
        0x1400 => "Dynamic Range",
        _ => return None,
    })
}

fn olympus(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x0201 => "Quality",
        0x0202 => "Macro Mode",
        0x0204 => "Digital Zoom",
        0x0207 => "Firmware Version",
        0x0208 => "Picture Info",
        0x0209 => "Camera ID",
        _ => return None,
    })
}

fn panasonic(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x01 => "Image Quality",
        0x03 => "White Balance",
        0x07 => "Focus Mode",
        0x0F => "AF Area Mode",
        0x1A => "Image Stabilization",
        0x1C => "Macro Mode",
        0x1F => "Shooting Mode",
        0x2C => "Contrast Mode",
        0x51 => "Lens Type",
        0x52 => "Lens Serial Number",
        _ => return None,
    })
}

/// Escolhe o leiaute pelo cabeçalho do blob (e, para o Canon, que não tem cabeçalho, pelo `Make`).
fn layout<'a>(
    mn: &'a [u8],
    mn_off: usize,
    tiff: &'a [u8],
    tiff_le: bool,
    make: &str,
) -> Option<Layout<'a>> {
    let make = make.to_ascii_lowercase();
    if mn.starts_with(b"Nikon\0") {
        // Cabeçalho "Nikon\0" versão(2) pad(2), depois um TIFF completo (o tipo 3).
        let t = mn.get(10..)?;
        let le = match t.get(..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let ifd = u32_at(t, 4, le)? as usize;
        return Some(Layout { buf: mn, base: 10, ifd: 10usize.checked_add(ifd)?, le, name: "Nikon", labels: nikon });
    }
    if mn.starts_with(b"SONY DSC \0") {
        return Some(Layout { buf: tiff, base: 0, ifd: mn_off.checked_add(12)?, le: tiff_le, name: "Sony", labels: sony });
    }
    if mn.starts_with(b"FUJIFILM") {
        let ifd = u32_at(mn, 8, true)? as usize;
        return Some(Layout { buf: mn, base: 0, ifd, le: true, name: "Fujifilm", labels: fuji });
    }
    if mn.starts_with(b"OLYMPUS\0") {
        let le = match mn.get(8..10)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        return Some(Layout { buf: mn, base: 0, ifd: 12, le, name: "Olympus", labels: olympus });
    }
    if mn.starts_with(b"OLYMP\0") {
        return Some(Layout { buf: tiff, base: 0, ifd: mn_off.checked_add(8)?, le: tiff_le, name: "Olympus", labels: olympus });
    }
    if mn.starts_with(b"Panasonic\0") {
        return Some(Layout { buf: tiff, base: 0, ifd: mn_off.checked_add(12)?, le: tiff_le, name: "Panasonic", labels: panasonic });
    }
    if make.starts_with("canon") {
        return Some(Layout { buf: tiff, base: 0, ifd: mn_off, le: tiff_le, name: "Canon", labels: canon });
    }
    None
}

/// Aba do fabricante, se o MakerNote for de um fabricante conhecido e tiver campos legíveis.
pub fn maker_of(exif: &Exif) -> Option<Maker> {
    let Value::Undefined(mn, off) = &exif.get_field(Tag::MakerNote, In::PRIMARY)?.value else {
        return None;
    };
    let make = match &exif.get_field(Tag::Make, In::PRIMARY)?.value {
        Value::Ascii(v) => String::from_utf8_lossy(v.first()?).into_owned(),
        _ => String::new(),
    };
    let l = layout(mn, *off as usize, exif.buf(), exif.little_endian(), &make)?;
    let rows = rows_of(&l);
    (!rows.is_empty()).then(|| Maker { name: l.name.to_string(), rows })
}

/// Dados da lente: tags EXIF `Lens*` e distância focal, com o `Lens Model` do MakerNote Canon
/// quando o EXIF não o traz.
pub fn lens_rows(exif: &Exif, maker: Option<&Maker>) -> Rows {
    let mut rows = Rows::new();
    let text = |tag: Tag| {
        let f = exif.get_field(tag, In::PRIMARY)?;
        let s = sanitize(f.display_value().to_string().trim_matches('"'));
        (!s.is_empty()).then_some(s)
    };
    let with_unit = |tag: Tag| {
        let f = exif.get_field(tag, In::PRIMARY)?;
        let s = sanitize(&f.display_value().with_unit(exif).to_string());
        (!s.is_empty()).then_some(s)
    };
    let mut push = |label: &str, v: Option<String>| {
        if let Some(v) = v {
            rows.push((label.to_string(), v));
        }
    };
    push("Lens Make", text(Tag::LensMake));
    let mut model = text(Tag::LensModel);
    if model.is_none() {
        model = maker
            .and_then(|m| m.rows.iter().find(|(k, _)| k == "Lens Model"))
            .map(|(_, v)| v.clone());
    }
    push("Lens Model", model);
    push("Lens Serial Number", text(Tag::LensSerialNumber));
    push("Lens Specification", with_unit(Tag::LensSpecification));
    push("Focal Length", with_unit(Tag::FocalLength));
    push("Focal Length (35 mm)", with_unit(Tag::FocalLengthIn35mmFilm));
    push("Maximum Aperture", with_unit(Tag::MaxApertureValue));
    push("F Number", with_unit(Tag::FNumber));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IFD com entradas `(tag, tipo, contagem, valor de 4 bytes ou deslocamento)`, little-endian.
    fn ifd(entries: &[(u16, u16, u32, [u8; 4])]) -> Vec<u8> {
        let mut o = (entries.len() as u16).to_le_bytes().to_vec();
        for (t, ty, c, v) in entries {
            o.extend_from_slice(&t.to_le_bytes());
            o.extend_from_slice(&ty.to_le_bytes());
            o.extend_from_slice(&c.to_le_bytes());
            o.extend_from_slice(v);
        }
        o.extend_from_slice(&[0; 4]);
        o
    }

    fn rows(l: &Layout) -> Rows {
        rows_of(l)
    }

    #[test]
    fn nikon_tipo3_le_texto_curto_numeros_e_racional() {
        // "Nikon\0" 02 10 00 00 | II*\0 offset=8 | IFD
        let mut mn = b"Nikon\0\x02\x10\0\0II*\0\x08\0\0\0".to_vec();
        let lens_off = (8 + 2 + 3 * 12 + 4) as u32; // depois do IFD
        mn.extend(ifd(&[
            (0x04, 2, 4, *b"FINE"),
            (0x02, 3, 2, [0x64, 0, 0, 0]),
            (0x84, 5, 1, lens_off.to_le_bytes()),
        ]));
        mn.extend_from_slice(&[0x1E, 0, 0, 0, 0x0A, 0, 0, 0]); // 30/10 = 3
        let l = layout(&mn, 0, &[], true, "NIKON CORPORATION").unwrap();
        let r = rows(&l);
        assert_eq!(l.name, "Nikon");
        assert!(r.contains(&("Quality".into(), "FINE".into())));
        assert!(r.contains(&("ISO".into(), "100 0".into())));
        assert!(r.iter().any(|(k, v)| k.starts_with("Lens") && v == "3"));
    }

    #[test]
    fn canon_usa_o_offset_do_tiff_principal() {
        // Buffer "TIFF": 8 bytes de lixo, depois o IFD do MakerNote em 8.
        let mut tiff = vec![0u8; 8];
        let val_off = (8 + 2 + 12 + 4) as u32;
        tiff.extend(ifd(&[(0x95, 2, 8, val_off.to_le_bytes())]));
        tiff.extend_from_slice(b"EF50mm\0\0");
        let l = layout(&tiff[8..], 8, &tiff, true, "Canon").unwrap();
        assert_eq!(rows(&l), vec![("Lens Model".to_string(), "EF50mm".to_string())]);
    }

    #[test]
    fn fabricante_desconhecido_ou_truncado_devolve_nada_e_nao_panica() {
        assert!(layout(b"qualquer coisa", 0, &[], true, "Acme").is_none());
        let mut mn = b"FUJIFILM".to_vec();
        mn.extend_from_slice(&12u32.to_le_bytes());
        mn.extend(ifd(&[(0x1000, 2, 4, *b"HIGH")]));
        for n in 0..mn.len() {
            if let Some(l) = layout(&mn[..n], 0, &[], true, "FUJIFILM") {
                let _ = rows(&l);
            }
        }
        let l = layout(&mn, 0, &[], true, "FUJIFILM").unwrap();
        assert_eq!(rows(&l), vec![("Quality".to_string(), "HIGH".to_string())]);
    }

    #[test]
    fn contagem_absurda_deslocamento_fora_e_entradas_demais_sao_ignorados() {
        let mut mn = b"FUJIFILM".to_vec();
        mn.extend_from_slice(&12u32.to_le_bytes());
        // contagem 0xFFFFFFFF de SHORT, deslocamento enorme, e deslocamento fora do blob
        mn.extend(ifd(&[
            (0x1001, 3, u32::MAX, [0, 0, 0, 0]),
            (0x1002, 3, 100, [0xFF, 0xFF, 0xFF, 0xFF]),
            (0x1003, 3, 100, [0xF0, 0, 0, 0]),
            (0x1004, 3, 1, [7, 0, 0, 0]),
        ]));
        let l = layout(&mn, 0, &[], true, "FUJIFILM").unwrap();
        assert_eq!(rows(&l), vec![("Contrast".to_string(), "7".to_string())]);
        // contagem de entradas declarada 65535 com o blob curto: lê só o que existe
        let mut curto = b"FUJIFILM".to_vec();
        curto.extend_from_slice(&12u32.to_le_bytes());
        curto.extend_from_slice(&[0xFF, 0xFF]);
        let l = layout(&curto, 0, &[], true, "FUJIFILM").unwrap();
        assert!(rows(&l).is_empty());
    }

    #[test]
    fn deslocamento_do_ifd_apontando_para_si_mesmo_nao_gira() {
        // IFD no início do próprio buffer: não seguimos "próximo IFD", então termina.
        let mut mn = b"FUJIFILM".to_vec();
        mn.extend_from_slice(&0u32.to_le_bytes());
        mn.extend_from_slice(&[1, 0]);
        let l = layout(&mn, 0, &[], true, "FUJIFILM").unwrap();
        let _ = rows(&l);
    }

    #[test]
    fn texto_do_fabricante_sai_sem_controles() {
        let mut mn = b"FUJIFILM".to_vec();
        mn.extend_from_slice(&12u32.to_le_bytes());
        mn.extend(ifd(&[(0x1000, 2, 4, [b'<', 0x07, b'b', b'>'])]));
        let l = layout(&mn, 0, &[], true, "FUJIFILM").unwrap();
        assert_eq!(rows(&l), vec![("Quality".to_string(), "< b>".to_string())]);
    }
}
