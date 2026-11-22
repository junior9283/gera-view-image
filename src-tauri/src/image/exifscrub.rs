//! Tira de um bloco EXIF (TIFF) as tags que repetem título, descrição e autor, sem reescrever o resto.
//!
//! O bloco é de um arquivo não confiável. Nada é movido: as entradas das tags tiradas saem da
//! tabela do IFD (as seguintes sobem) e os bytes dos valores delas são zerados, mas só se a faixa
//! não tocar o cabeçalho, uma tabela de IFD nem o valor de uma entrada que fica (isso também cobre
//! valor compartilhado, MakerNote e miniatura). Se alguma limpeza não puder ser feita com
//! segurança (tipo desconhecido, faixa que cruza algo mantido, tabela quebrada), devolve `None` e
//! quem chama descarta o EXIF inteiro: o texto antigo nunca sobrevive por falha da limpeza.
use super::makernote::{tiff_header, u16_at};
use std::ops::Range;

/// Tags a tirar do IFD0/IFD1 (`tiff`) e do sub-IFD Exif (`exif`).
pub struct Tags<'a> {
    pub tiff: &'a [u16],
    pub exif: &'a [u16],
}

const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;
const TAG_INTEROP_IFD: u16 = 0xA005;
const TAG_THUMB_OFFSET: u16 = 0x0201;
const TAG_THUMB_LENGTH: u16 = 0x0202;
/// Teto de entradas visitadas em todos os IFDs.
const MAX_ENTRIES: usize = 20_000;

/// Tamanho em bytes de um elemento do tipo TIFF/EXIF; `None` para tipo desconhecido.
fn unit(ty: u16) -> Option<usize> {
    Some(match ty {
        1 | 2 | 6 | 7 | 129 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 => 8,
        _ => return None,
    })
}

struct Reader<'a> {
    b: &'a [u8],
    le: bool,
}

impl Reader<'_> {
    fn u16(&self, o: usize) -> Option<u16> {
        u16_at(self.b, o, self.le)
    }

    fn u32(&self, o: usize) -> Option<u32> {
        let a: [u8; 4] = self.b.get(o..o.checked_add(4)?)?.try_into().ok()?;
        Some(if self.le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    }
}

struct Entry {
    tag: u16,
    /// Posição da entrada de 12 bytes.
    at: usize,
    /// Faixa do valor fora da entrada (`None` se cabe nos 4 bytes ou aponta para fora do bloco).
    value: Option<Range<usize>>,
    /// Tipo desconhecido: o tamanho do valor não existe.
    unknown_type: bool,
    drop: bool,
}

struct Table {
    /// Posição da contagem de entradas.
    at: usize,
    /// Fim das entradas (onde está o ponteiro do próximo IFD).
    end: usize,
    entries: Vec<Entry>,
    next: usize,
}

/// Lê a tabela do IFD em `at`; `drop` diz quais tags saem.
fn table(r: &Reader, at: usize, drop: &[u16], budget: &mut usize) -> Option<Table> {
    let n = usize::from(r.u16(at)?);
    let first = at.checked_add(2)?;
    let end = first.checked_add(n * 12)?;
    if end > r.b.len() || n > *budget {
        return None;
    }
    *budget -= n;
    let mut entries = Vec::with_capacity(n);
    for i in 0..n {
        let o = first + i * 12;
        let (tag, ty, count) = (r.u16(o)?, r.u16(o + 2)?, r.u32(o + 4)? as usize);
        let size = unit(ty);
        let value = size.and_then(|s| s.checked_mul(count)).filter(|&l| l > 4).and_then(|len| {
            let off = r.u32(o + 8)? as usize;
            let stop = off.checked_add(len)?;
            (stop <= r.b.len()).then_some(off..stop)
        });
        entries.push(Entry { tag, at: o, value, unknown_type: size.is_none(), drop: drop.contains(&tag) });
    }
    // Ponteiro ausente (bloco cortado logo depois das entradas) vale 0: não há próximo IFD.
    let next = r.u32(end).unwrap_or(0) as usize;
    Some(Table { at, end, entries, next })
}

fn overlaps(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}

/// `Some(bloco limpo)`, ou `None` se não der para limpar com segurança.
pub fn scrub(tiff: &[u8], tags: &Tags) -> Option<Vec<u8>> {
    let (ifd0, le) = tiff_header(tiff)?;
    let r = Reader { b: tiff, le };
    let mut budget = MAX_ENTRIES;
    // IFD0, IFD1 (próximo IFD do IFD0) e, a partir do IFD0, os sub-IFDs Exif, GPS e interoperabilidade.
    let t0 = table(&r, ifd0, tags.tiff, &mut budget)?;
    let sub = |t: &Table, tag: u16, drop: &[u16], budget: &mut usize| -> Option<Table> {
        let e = t.entries.iter().find(|e| e.tag == tag)?;
        table(&r, r.u32(e.at + 8)? as usize, drop, budget)
    };
    let exif = sub(&t0, TAG_EXIF_IFD, tags.exif, &mut budget);
    let gps = sub(&t0, TAG_GPS_IFD, &[], &mut budget);
    let interop = exif.as_ref().and_then(|t| sub(t, TAG_INTEROP_IFD, &[], &mut budget));
    let t1 = (t0.next != 0).then(|| table(&r, t0.next, tags.tiff, &mut budget)).flatten();
    let tables: Vec<&Table> = [Some(&t0), exif.as_ref(), gps.as_ref(), interop.as_ref(), t1.as_ref()]
        .into_iter()
        .flatten()
        .collect();
    // Duas tabelas no mesmo lugar: arquivo forjado, e compactar duas vezes o estragaria.
    for (i, a) in tables.iter().enumerate() {
        if tables[i + 1..].iter().any(|b| b.at == a.at) {
            return None;
        }
    }
    if !tables.iter().any(|t| t.entries.iter().any(|e| e.drop)) {
        return Some(tiff.to_vec());
    }
    // Faixas que não podem ser zeradas: cabeçalho, tabelas, valores mantidos e miniatura.
    let mut protected: Vec<Range<usize>> = Vec::new();
    protected.push(0..8);
    for t in &tables {
        protected.push(t.at..(t.end + 4).min(tiff.len()));
        protected.extend(t.entries.iter().filter(|e| !e.drop).filter_map(|e| e.value.clone()));
    }
    if let Some(t) = &t1 {
        let get = |tag| t.entries.iter().find(|e| e.tag == tag).and_then(|e| r.u32(e.at + 8));
        if let (Some(off), Some(len)) = (get(TAG_THUMB_OFFSET), get(TAG_THUMB_LENGTH)) {
            protected.push(off as usize..(off as usize).saturating_add(len as usize));
        }
    }
    let mut zero: Vec<Range<usize>> = Vec::new();
    for e in tables.iter().flat_map(|t| &t.entries).filter(|e| e.drop) {
        if e.unknown_type {
            return None; // não dá para saber quantos bytes o valor ocupa
        }
        if let Some(v) = &e.value {
            if protected.iter().any(|p| overlaps(p, v)) {
                return None;
            }
            zero.push(v.clone());
        }
    }
    let mut out = tiff.to_vec();
    for v in zero {
        out[v].fill(0);
    }
    for t in tables {
        compact(&mut out, t, le);
    }
    Some(out)
}

/// Tira da tabela as entradas marcadas: as seguintes sobem, o ponteiro do próximo IFD acompanha e
/// o espaço que sobra é zerado.
fn compact(b: &mut [u8], t: &Table, le: bool) {
    let kept: Vec<[u8; 12]> = t
        .entries
        .iter()
        .filter(|e| !e.drop)
        .filter_map(|e| b.get(e.at..e.at + 12)?.try_into().ok())
        .collect();
    if kept.len() == t.entries.len() {
        return;
    }
    let first = t.at + 2;
    let count = if le { (kept.len() as u16).to_le_bytes() } else { (kept.len() as u16).to_be_bytes() };
    b[t.at..first].copy_from_slice(&count);
    let next = if le { (t.next as u32).to_le_bytes() } else { (t.next as u32).to_be_bytes() };
    let stop = (t.end + 4).min(b.len());
    let mut o = first;
    for entry in &kept {
        b[o..o + 12].copy_from_slice(entry);
        o += 12;
    }
    b[o..stop].fill(0);
    if let Some(slot) = b.get_mut(o..o + 4) {
        slot.copy_from_slice(&next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::test_util::tiff_le;

    fn ascii(s: &str) -> (u16, u32, Vec<u8>) {
        let mut b = s.as_bytes().to_vec();
        b.push(0);
        (2, b.len() as u32, b)
    }

    fn ent(tag: u16, (ty, count, data): (u16, u32, Vec<u8>)) -> (u16, u16, u32, Vec<u8>) {
        (tag, ty, count, data)
    }

    const T: Tags = Tags { tiff: &[0x013B], exif: &[0xA437] };

    fn tem(b: &[u8], s: &str) -> bool {
        b.windows(s.len()).any(|w| w == s.as_bytes())
    }

    #[test]
    fn tira_a_entrada_e_zera_so_o_valor_dela() {
        let f = tiff_le(&[ent(0x010F, ascii("Gera Marca")), ent(0x013B, ascii("Segredo Velho"))]);
        let out = scrub(&f, &T).unwrap();
        assert!(!tem(&out, "Segredo"));
        assert!(tem(&out, "Gera Marca"));
        let r = exif::Reader::new().read_raw(out).unwrap();
        assert!(r.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        assert!(r.get_field(exif::Tag::Artist, exif::In::PRIMARY).is_none());
    }

    #[test]
    fn valor_compartilhado_com_entrada_mantida_nao_e_zerado_e_o_exif_cai() {
        // Make e Artist apontam para o mesmo valor: zerar quebraria o Make.
        let mut f = tiff_le(&[ent(0x010F, ascii("Compartilhado")), ent(0x013B, ascii("Compartilhado"))]);
        let off0 = u32::from_le_bytes(f[18..22].try_into().unwrap());
        f[8 + 2 + 12 + 8..8 + 2 + 12 + 12].copy_from_slice(&off0.to_le_bytes());
        assert_eq!(scrub(&f, &T), None);
    }

    #[test]
    fn valor_forjado_sobre_cabecalho_ou_tabela_e_recusado() {
        for alvo in [0u32, 8, 12] {
            let mut f = tiff_le(&[ent(0x013B, ascii("Segredo Velho"))]);
            f[18..22].copy_from_slice(&alvo.to_le_bytes());
            assert_eq!(scrub(&f, &T), None, "valor em {alvo}");
        }
    }

    #[test]
    fn tipo_desconhecido_na_tag_tirada_derruba_o_bloco() {
        let mut f = tiff_le(&[ent(0x013B, ascii("Segredo Velho"))]);
        f[12..14].copy_from_slice(&200u16.to_le_bytes());
        assert_eq!(scrub(&f, &T), None);
    }

    #[test]
    fn tipo_129_e_um_byte_por_elemento() {
        let mut f = tiff_le(&[ent(0x013B, (129, 14, b"Segredo Velho\0".to_vec()))]);
        let out = scrub(&f, &T).unwrap();
        assert!(!tem(&out, "Segredo"));
        f.truncate(f.len() - 6); // valor fora do bloco: nada a zerar, a entrada sai mesmo assim
        assert!(scrub(&f, &T).is_some());
    }

    #[test]
    fn sem_ponteiro_do_proximo_ifd_vale_zero() {
        let f = tiff_le(&[ent(0x013B, (1, 2, vec![1, 2])), ent(0x010F, (1, 2, vec![3, 4]))]);
        let cortado = &f[..8 + 2 + 24]; // termina logo depois das entradas
        let out = scrub(cortado, &T).unwrap();
        assert_eq!(u16::from_le_bytes(out[8..10].try_into().unwrap()), 1);
    }

    #[test]
    fn truncamentos_e_bytes_trocados_nao_panicam() {
        let f = tiff_le(&[ent(0x010F, ascii("Gera")), ent(0x013B, ascii("Segredo Velho"))]);
        for n in 0..f.len() {
            let _ = scrub(&f[..n], &T);
        }
        let mut st = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..2000 {
            let mut b = f.clone();
            for _ in 0..3 {
                st ^= st << 13;
                st ^= st >> 7;
                st ^= st << 17;
                let i = (st as usize) % b.len();
                b[i] = (st >> 32) as u8;
            }
            let _ = scrub(&b, &T);
        }
    }
}
