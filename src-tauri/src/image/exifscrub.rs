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
    /// O ponteiro do próximo IFD existe e não é parte de um valor: senão a tabela acaba em `end`.
    has_slot: bool,
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
        // Valor que passa do fim do bloco: a faixa vai até o fim (é o que um leitor tolerante leria).
        let value = size.and_then(|s| s.checked_mul(count)).filter(|&l| l > 4).and_then(|len| {
            let off = r.u32(o + 8)? as usize;
            let stop = off.checked_add(len).map_or(r.b.len(), |e| e.min(r.b.len()));
            (off < stop).then_some(off..stop)
        });
        entries.push(Entry { tag, at: o, value, unknown_type: size.is_none(), drop: drop.contains(&tag) });
    }
    // Ponteiro ausente (bloco cortado logo depois das entradas) ou ocupado por um valor (gravador que
    // o omite) vale 0: não há próximo IFD, e nada ali é zerado nem sobrescrito.
    let slot = end..end + 4;
    let has_slot = end + 4 <= r.b.len()
        && !entries.iter().any(|e| e.value.as_ref().is_some_and(|v| overlaps(v, &slot)));
    let next = if has_slot { r.u32(end).unwrap_or(0) as usize } else { 0 };
    Some(Table { at, end, entries, next, has_slot })
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
    let mut t0 = table(&r, ifd0, tags.tiff, &mut budget)?;
    // Sub-IFD Exif: ausente é normal; presente e ilegível (ou apontado duas vezes) não dá para limpar.
    let pointers = |t: &Table, tag: u16| t.entries.iter().filter(|e| e.tag == tag).count();
    let sub = |t: &Table, tag: u16, drop: &[u16], budget: &mut usize| -> Option<Table> {
        let e = t.entries.iter().find(|e| e.tag == tag)?;
        table(&r, r.u32(e.at + 8)? as usize, drop, budget)
    };
    let exif = sub(&t0, TAG_EXIF_IFD, tags.exif, &mut budget);
    if pointers(&t0, TAG_EXIF_IFD) > 1 || (pointers(&t0, TAG_EXIF_IFD) == 1 && exif.is_none()) {
        return None;
    }
    // GPS e interoperabilidade não levam texto: se estiverem quebrados, só não protegem nada.
    let gps = sub(&t0, TAG_GPS_IFD, &[], &mut budget);
    let interop = exif.as_ref().and_then(|t| sub(t, TAG_INTEROP_IFD, &[], &mut budget));
    // IFD1: ilegível corta a cadeia (o IFD0 passa a dizer que não há próximo) em vez de derrubar o EXIF.
    let t1 = (t0.next != 0).then(|| table(&r, t0.next, tags.tiff, &mut budget)).flatten();
    if t1.is_none() {
        t0.next = 0;
    }
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
        protected.push(t.at..t.end + if t.has_slot { 4 } else { 0 });
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
    // Sem ponteiro próprio (omitido, cortado ou ocupado por um valor), a tabela acaba em `end` e o
    // que vem depois não é tocado.
    let stop = if t.has_slot { t.end + 4 } else { t.end };
    let mut o = first;
    for entry in &kept {
        b[o..o + 12].copy_from_slice(entry);
        o += 12;
    }
    b[o..stop].fill(0);
    if t.has_slot {
        b[o..o + 4].copy_from_slice(&next);
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

    /// IFD0 `[(tag, tipo, contagem, 4 bytes)]` (todos os valores inline) seguido de `tail`; o
    /// ponteiro do próximo IFD vale `next`. Os deslocamentos de `tail` começam em `base()`.
    fn ifd0(entries: &[(u16, u16, u32, [u8; 4])], next: u32, tail: &[u8]) -> Vec<u8> {
        let mut out = b"II*\0\x08\0\0\0".to_vec();
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, ty, count, v) in entries {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&ty.to_le_bytes());
            out.extend_from_slice(&count.to_le_bytes());
            out.extend_from_slice(v);
        }
        out.extend_from_slice(&next.to_le_bytes());
        out.extend_from_slice(tail);
        out
    }

    fn base(n: usize) -> u32 {
        (8 + 2 + 12 * n + 4) as u32
    }

    const ARTIST: (u16, u16, u32, [u8; 4]) = (0x013B, 2, 3, *b"Ab\0\0");

    #[test]
    fn sub_ifd_exif_ausente_e_normal_ilegivel_ou_duplicado_derruba_o_bloco() {
        let sem = ifd0(&[ARTIST], 0, &[]);
        assert!(scrub(&sem, &T).is_some());
        // ponteiro Exif para fora do bloco: ilegível
        let fora = ifd0(&[ARTIST, (0x8769, 4, 1, 0xFFFFu32.to_le_bytes())], 0, &[]);
        assert_eq!(scrub(&fora, &T), None);
        // ponteiro para uma tabela vazia: legível
        let ok = ifd0(&[ARTIST, (0x8769, 4, 1, base(2).to_le_bytes())], 0, &[0, 0, 0, 0, 0, 0]);
        assert!(scrub(&ok, &T).is_some());
        // dois ponteiros Exif: forjado
        let dois = ifd0(&[ARTIST, (0x8769, 4, 1, base(3).to_le_bytes()), (0x8769, 4, 1, base(3).to_le_bytes())], 0, &[0, 0, 0, 0, 0, 0]);
        assert_eq!(scrub(&dois, &T), None);
        // tabela Exif cortada no meio das entradas
        let cortada = ifd0(&[ARTIST, (0x8769, 4, 1, base(2).to_le_bytes())], 0, &[5, 0, 1, 2]);
        assert_eq!(scrub(&cortada, &T), None);
    }

    #[test]
    fn texto_no_sub_ifd_exif_sai() {
        // UserComment (0x9286) no sub-IFD Exif é o "equivalente" da descrição.
        let t = Tags { tiff: &[], exif: &[0x9286] };
        let tail = [vec![1, 0], [0x86, 0x92, 2, 0, 3, 0, 0, 0, b'x', b'y', 0, 0].to_vec(), vec![0; 4]].concat();
        let f = ifd0(&[(0x8769, 4, 1, base(1).to_le_bytes())], 0, &tail);
        let out = scrub(&f, &t).unwrap();
        let sub = base(1) as usize;
        assert_eq!(u16::from_le_bytes(out[sub..sub + 2].try_into().unwrap()), 0, "entrada tirada");
    }

    #[test]
    fn proximo_ifd_quebrado_corta_a_cadeia_sem_derrubar_o_exif() {
        let f = ifd0(&[ARTIST, (0x0100, 3, 1, [1, 0, 0, 0])], 0x00FF_FFFF, &[]);
        let out = scrub(&f, &T).unwrap();
        assert_eq!(u16::from_le_bytes(out[8..10].try_into().unwrap()), 1);
        assert_eq!(&out[8 + 2 + 12..8 + 2 + 12 + 4], &[0, 0, 0, 0], "próximo IFD = 0");
    }

    #[test]
    fn texto_do_ifd1_legivel_sai() {
        // IFD1 com Artist, logo depois do IFD0.
        let ifd1 = [
            vec![1, 0],
            [0x3B, 0x01, 2, 0, 3, 0, 0, 0, b'A', b'b', 0, 0].to_vec(),
            vec![0; 4],
        ]
        .concat();
        let f = ifd0(&[(0x0100, 3, 1, [1, 0, 0, 0])], base(1), &ifd1);
        let out = scrub(&f, &T).unwrap();
        let at = base(1) as usize;
        assert_eq!(u16::from_le_bytes(out[at..at + 2].try_into().unwrap()), 0, "Artist do IFD1 saiu");
    }

    #[test]
    fn valor_que_passa_do_fim_e_zerado_ate_o_fim_se_nada_mantido_estiver_la() {
        let tail = b"abcdefgh";
        let artist_longo = (0x013B, 2, 100, base(1).to_le_bytes()); // 100 bytes, só 8 existem
        let f = ifd0(&[artist_longo], 0, tail);
        let out = scrub(&f, &T).unwrap();
        assert!(!tem(&out, "abcdefgh") && out.len() == f.len());
        // se o valor estourado cruza um valor mantido, o bloco cai
        let make = (0x010F, 2, 8, base(2).to_le_bytes());
        let artist = (0x013B, 2, 100, (base(2) - 8).to_le_bytes()); // 100 bytes a partir de antes do valor de Make
        let g = ifd0(&[make, artist], 0, b"MakeDado");
        assert_eq!(scrub(&g, &T), None);
    }

    #[test]
    fn valor_mantido_logo_depois_das_entradas_sem_ponteiro_de_proximo_ifd_nao_e_tocado() {
        // Gravador que omite o ponteiro do próximo IFD: o valor de Make começa onde ele estaria.
        let mut f = b"II*\0\x08\0\0\0".to_vec();
        f.extend_from_slice(&2u16.to_le_bytes());
        f.extend_from_slice(&[0x3B, 0x01, 1, 0, 2, 0, 0, 0, 7, 8, 0, 0]); // Artist inline
        f.extend_from_slice(&[0x0F, 0x01, 2, 0, 5, 0, 0, 0]);
        f.extend_from_slice(&34u32.to_le_bytes()); // Make em 34 = fim das entradas
        f.extend_from_slice(b"Gera\0");
        let out = scrub(&f, &T).expect("não derruba o EXIF");
        assert!(tem(&out, "Gera"), "o valor mantido continua lá");
        let r = exif::Reader::new().read_raw(out).unwrap();
        assert!(r.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        assert!(r.get_field(exif::Tag::Artist, exif::In::PRIMARY).is_none());
    }

    #[test]
    fn mutacao_de_bytes_com_sub_ifd_e_ifd1_nao_entra_em_panico() {
        let ifd1 = [vec![1, 0], [0x3B, 0x01, 2, 0, 3, 0, 0, 0, b'A', b'b', 0, 0].to_vec(), vec![0; 4]].concat();
        let exif_ifd = [vec![1, 0], [0x86, 0x92, 2, 0, 3, 0, 0, 0, b'x', b'y', 0, 0].to_vec(), vec![0; 4]].concat();
        let off_exif = base(3) + ifd1.len() as u32;
        let f = ifd0(&[ARTIST, (0x0100, 3, 1, [1, 0, 0, 0]), (0x8769, 4, 1, off_exif.to_le_bytes())], base(3), &[ifd1, exif_ifd].concat());
        let t = Tags { tiff: &[0x013B], exif: &[0x9286] };
        assert!(scrub(&f, &t).is_some());
        let mut st = 0x1234_5678_9ABC_DEF1u64;
        for _ in 0..5000 {
            let mut b = f.clone();
            for _ in 0..1 + st % 4 {
                st ^= st << 13;
                st ^= st >> 7;
                st ^= st << 17;
                let i = (st as usize) % b.len();
                b[i] = (st >> 16) as u8;
            }
            if let Some(out) = scrub(&b, &t) {
                assert_eq!(out.len(), b.len(), "o tamanho do bloco não muda");
            }
        }
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
