//! Metadados dentro dos contêineres, para gravar e reler: IFDs TIFF (EXIF, IPTC, XMP, ICC,
//! DPI), BMP v5 com perfil ICC, XMP estendido do JPEG e ajustes no bloco EXIF.
//! Tudo tolerante: entrada malformada devolve `None` ou volta como veio, nunca pânico.

pub const TAG_XMP: u16 = 700;
pub const TAG_IPTC: u16 = 33723;
pub const TAG_ICC: u16 = 34675;
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;
const TAG_INTEROP_IFD: u16 = 0xA005;
/// Tags do IFD0 de um EXIF que descrevem a foto (e não o arquivo de origem: tiras,
/// compressão, miniatura, orientação). Vão para o IFD0 do TIFF gravado.
const IFD0_DESCRIPTIVE: [u16; 7] = [270, 271, 272, 305, 306, 315, 33432];
/// Teto de um valor de tag (proteção contra contagens absurdas).
const MAX_VALUE: usize = 64 << 20;
/// Tetos da leitura inteira de um TIFF (todos os IFDs somados): um arquivo forjado com
/// milhares de entradas repetidas ou sub-IFDs em ciclo não trava nem estoura a memória.
const MAX_ENTRIES: usize = 4096;
const MAX_TOTAL_BYTES: usize = 64 << 20;

/// Orçamento de uma leitura: entradas e bytes copiados restantes e IFDs já visitados.
struct Budget {
    entries: usize,
    bytes: usize,
    seen: std::collections::HashSet<usize>,
}

/// Entrada de IFD com o valor já em little-endian.
#[derive(Debug, Clone, PartialEq)]
struct Entry {
    tag: u16,
    ty: u16,
    count: u32,
    data: Vec<u8>,
    /// Sub-IFD (EXIF, GPS, interoperabilidade) já lido; gravado como ponteiro LONG.
    sub: Option<Vec<Entry>>,
}

impl Entry {
    fn raw(tag: u16, ty: u16, data: &[u8]) -> Self {
        Entry {
            tag,
            ty,
            count: data.len() as u32,
            data: data.to_vec(),
            sub: None,
        }
    }
}

/// `(bytes por elemento, tamanho da unidade que inverte com a ordem dos bytes)`.
fn unit(ty: u16) -> Option<(usize, usize)> {
    Some(match ty {
        1 | 2 | 6 | 7 => (1, 1),
        3 | 8 => (2, 2),
        4 | 9 | 11 | 13 => (4, 4),
        5 | 10 => (8, 4),
        12 => (8, 8),
        _ => return None,
    })
}

/// Blocos opacos (o leitor os trata como bytes, qualquer que seja o tipo declarado).
fn opaque(tag: u16) -> bool {
    matches!(tag, TAG_XMP | TAG_IPTC | TAG_ICC)
}

fn swap_units(d: &mut [u8], unit: usize) {
    if unit > 1 {
        d.chunks_exact_mut(unit).for_each(<[u8]>::reverse);
    }
}

struct Reader<'a> {
    b: &'a [u8],
    le: bool,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Option<Self> {
        let le = match b.get(..4)? {
            b"II*\0" => true,
            b"MM\0*" => false,
            _ => return None,
        };
        Some(Reader { b, le })
    }

    fn u16(&self, i: usize) -> Option<u16> {
        let a = self.b.get(i..i.checked_add(2)?)?.try_into().ok()?;
        Some(if self.le {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        })
    }

    fn u32(&self, i: usize) -> Option<u32> {
        let a = self.b.get(i..i.checked_add(4)?)?.try_into().ok()?;
        Some(if self.le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    }

    fn ifd0(&self) -> Option<usize> {
        self.u32(4).map(|o| o as usize)
    }

    /// Posição da entrada `tag` no IFD em `ifd`.
    fn find(&self, ifd: usize, tag: u16) -> Option<usize> {
        let n = self.u16(ifd)? as usize;
        (0..n)
            .map(|k| ifd + 2 + 12 * k)
            .find(|&e| self.u16(e) == Some(tag))
    }

    /// Entradas do IFD em `off`, com os sub-IFDs conhecidos lidos até a profundidade 2
    /// (`depth` = 2 não lê sub-IFDs), dentro de um orçamento próprio.
    fn read_ifd(&self, off: usize, depth: u8) -> Option<Vec<Entry>> {
        let mut budget = Budget {
            entries: MAX_ENTRIES,
            bytes: MAX_TOTAL_BYTES,
            seen: Default::default(),
        };
        self.entries(off, depth, &mut budget)
    }

    fn entries(&self, off: usize, depth: u8, budget: &mut Budget) -> Option<Vec<Entry>> {
        if !budget.seen.insert(off) {
            return None; // ciclo ou IFD repetido
        }
        let n = self.u16(off)? as usize;
        let mut out = Vec::with_capacity(n.min(256));
        for k in 0..n.min(1024) {
            if budget.entries == 0 {
                break;
            }
            budget.entries -= 1;
            let e = off + 2 + 12 * k;
            let (Some(tag), Some(ty), Some(count)) = (self.u16(e), self.u16(e + 2), self.u32(e + 4))
            else {
                break;
            };
            let Some((size, swap)) = unit(ty) else {
                continue;
            };
            let Some(len) = (count as usize)
                .checked_mul(size)
                .filter(|&l| l <= MAX_VALUE && l <= budget.bytes)
            else {
                continue;
            };
            let start = if len <= 4 {
                e + 8
            } else {
                match self.u32(e + 8) {
                    Some(o) => o as usize,
                    None => continue,
                }
            };
            let Some(raw) = self.b.get(start..start + len) else {
                continue;
            };
            budget.bytes -= len;
            let mut data = raw.to_vec();
            if !self.le && !opaque(tag) {
                swap_units(&mut data, swap);
            }
            let sub = if matches!(tag, TAG_EXIF_IFD | TAG_GPS_IFD | TAG_INTEROP_IFD)
                && matches!(ty, 4 | 13)
                && count == 1
                && depth < 2
            {
                match self
                    .u32(e + 8)
                    .and_then(|o| self.entries(o as usize, depth + 1, budget))
                {
                    Some(s) => Some(s),
                    None => continue, // ponteiro quebrado: a entrada some
                }
            } else {
                None
            };
            out.push(Entry {
                tag,
                ty,
                count,
                data,
                sub,
            });
        }
        Some(out)
    }
}

fn put16(v: &mut Vec<u8>, x: u16, le: bool) {
    v.extend(if le { x.to_le_bytes() } else { x.to_be_bytes() });
}

fn put32(v: &mut Vec<u8>, x: u32, le: bool) {
    v.extend(if le { x.to_le_bytes() } else { x.to_be_bytes() });
}

/// Escreve `entries` como IFD (ordenado por tag, sem próximo IFD) no fim de `out`, com os
/// valores e sub-IFDs depois dele. Devolve a posição do IFD.
fn write_ifd(out: &mut Vec<u8>, entries: &[Entry], le: bool) -> Option<u32> {
    let mut entries: Vec<&Entry> = entries.iter().collect();
    entries.sort_by_key(|e| e.tag);
    entries.dedup_by_key(|e| e.tag);
    if out.len() % 2 == 1 {
        out.push(0);
    }
    let at = out.len();
    out.resize(at + 2 + 12 * entries.len() + 4, 0);
    let mut table = Vec::with_capacity(2 + 12 * entries.len() + 4);
    put16(&mut table, entries.len() as u16, le);
    for e in entries {
        put16(&mut table, e.tag, le);
        if let Some(sub) = &e.sub {
            let off = write_ifd(out, sub, le)?;
            put16(&mut table, 4, le);
            put32(&mut table, 1, le);
            put32(&mut table, off, le);
            continue;
        }
        put16(&mut table, e.ty, le);
        put32(&mut table, e.count, le);
        let mut d = e.data.clone();
        if !le && !opaque(e.tag) {
            swap_units(&mut d, unit(e.ty)?.1);
        }
        if d.len() <= 4 {
            d.resize(4, 0);
            table.extend(d);
        } else {
            if out.len() % 2 == 1 {
                out.push(0);
            }
            put32(&mut table, u32::try_from(out.len()).ok()?, le);
            out.extend(d);
        }
    }
    put32(&mut table, 0, le);
    out[at..at + table.len()].copy_from_slice(&table);
    u32::try_from(at).ok()
}

/// Entradas de um EXIF que valem para a imagem gravada: as descritivas e os sub-IFDs EXIF/GPS.
fn exif_entries(r: &Reader) -> Vec<Entry> {
    let Some(all) = r.ifd0().and_then(|o| r.read_ifd(o, 0)) else {
        return Vec::new();
    };
    all.into_iter()
        .filter(|e| {
            IFD0_DESCRIPTIVE.contains(&e.tag)
                || (e.sub.is_some() && matches!(e.tag, TAG_EXIF_IFD | TAG_GPS_IFD))
        })
        .collect()
}

/// Bloco EXIF (TIFF little-endian) com as tags descritivas e os sub-IFDs EXIF/GPS do IFD0
/// de um arquivo TIFF. `None` se o arquivo não tiver nenhuma.
pub fn tiff_exif_block(file: &[u8]) -> Option<Vec<u8>> {
    let keep = exif_entries(&Reader::new(file)?);
    if keep.is_empty() {
        return None;
    }
    let mut out = b"II*\0\0\0\0\0".to_vec();
    let off = write_ifd(&mut out, &keep, true)?;
    out[4..8].copy_from_slice(&off.to_le_bytes());
    Some(out)
}

/// Valor cru de uma tag do IFD0 de um TIFF (`TAG_XMP`, `TAG_IPTC`, `TAG_ICC`).
pub fn tiff_tag(file: &[u8], tag: u16) -> Option<Vec<u8>> {
    let r = Reader::new(file)?;
    r.read_ifd(r.ifd0()?, 2)?
        .into_iter()
        .find(|e| e.tag == tag)
        .map(|e| e.data)
}

/// Metadados a gravar num TIFF.
#[derive(Debug, Default)]
pub struct TiffMeta<'a> {
    /// Bloco EXIF (TIFF): as tags descritivas vão para o IFD0, os sub-IFDs EXIF/GPS junto.
    pub exif: Option<&'a [u8]>,
    pub iptc: Option<&'a [u8]>,
    pub xmp: Option<&'a str>,
    pub icc: Option<&'a [u8]>,
    pub dpi: Option<(f32, f32)>,
}

/// TIFF de uma página com os metadados no IFD0. O IFD regravado vai para o fim do arquivo
/// (o antigo vira espaço morto, de algumas centenas de bytes). `None` se o TIFF for ilegível.
pub fn tiff_with_meta(tiff: &[u8], m: &TiffMeta) -> Option<Vec<u8>> {
    let r = Reader::new(tiff)?;
    let mut entries = r.read_ifd(r.ifd0()?, 0)?;
    let mut extra = m
        .exif
        .and_then(Reader::new)
        .map(|e| exif_entries(&e))
        .unwrap_or_default();
    if let Some(i) = m.iptc {
        extra.push(Entry::raw(TAG_IPTC, 7, i));
    }
    if let Some(x) = m.xmp {
        extra.push(Entry::raw(TAG_XMP, 1, x.as_bytes()));
    }
    if let Some(icc) = m.icc {
        extra.push(Entry::raw(TAG_ICC, 7, icc));
    }
    if let Some((x, y)) = m.dpi {
        let rational = |v: f32| {
            let n = (v.max(0.0) * 100.0).round() as u32;
            Entry {
                count: 1,
                ..Entry::raw(0, 5, &[n.to_le_bytes(), 100u32.to_le_bytes()].concat())
            }
        };
        extra.push(Entry { tag: 282, ..rational(x) });
        extra.push(Entry { tag: 283, ..rational(y) });
        extra.push(Entry {
            count: 1,
            ..Entry::raw(296, 3, &2u16.to_le_bytes()) // polegadas
        });
    }
    entries.retain(|e| !extra.iter().any(|x| x.tag == e.tag));
    entries.extend(extra);
    let mut out = tiff.to_vec();
    let off = write_ifd(&mut out, &entries, r.le)?;
    out[4..8].copy_from_slice(&if r.le {
        off.to_le_bytes()
    } else {
        off.to_be_bytes()
    });
    Some(out)
}

/// EXIF (bloco TIFF) com a resolução `dpi` no IFD0; sem EXIF, um bloco só com ela. O IFD0 é
/// regravado no fim, sem o IFD1 (a miniatura embutida). `None` se o bloco for ilegível.
pub fn exif_with_dpi(exif: Option<&[u8]>, dpi: f32) -> Option<Vec<u8>> {
    // IFD0 vazio: zero entradas e nenhum IFD seguinte.
    const EMPTY: &[u8] = b"II*\0\x08\0\0\0\0\0\0\0\0\0";
    let meta = TiffMeta {
        dpi: Some((dpi, dpi)),
        ..TiffMeta::default()
    };
    tiff_with_meta(exif.unwrap_or(EMPTY), &meta)
}

/// EXIF com `PixelXDimension`/`PixelYDimension` (sub-IFD EXIF) iguais a `w`x`h`, quando as
/// tags existem. Bloco ilegível volta como veio.
pub fn exif_set_pixel_dims(tiff: &[u8], (w, h): (u32, u32)) -> Vec<u8> {
    let mut t = tiff.to_vec();
    let Some(r) = Reader::new(tiff) else {
        return t;
    };
    let Some(exif) = r
        .ifd0()
        .and_then(|o| r.find(o, TAG_EXIF_IFD))
        .and_then(|e| r.u32(e + 8))
    else {
        return t;
    };
    for (tag, v) in [(0xA002, w), (0xA003, h)] {
        let Some(e) = r.find(exif as usize, tag).filter(|&e| r.u32(e + 4) == Some(1)) else {
            continue;
        };
        let mut value = Vec::with_capacity(4);
        match r.u16(e + 2) {
            Some(3) if v <= u16::MAX as u32 => {
                put16(&mut value, v as u16, r.le);
                value.extend([0, 0]);
            }
            Some(3 | 4) => {
                // Não cabe em SHORT: a entrada passa a LONG (o valor continua dentro dela).
                put32(&mut value, v, r.le);
            }
            _ => continue,
        }
        // Entrada cortada no fim do bloco: a tag fica como está.
        let Some(entry) = t.get_mut(e..e + 12) else {
            continue;
        };
        if v > u16::MAX as u32 {
            let mut ty = Vec::new();
            put16(&mut ty, 4, r.le);
            entry[2..4].copy_from_slice(&ty);
        }
        entry[8..].copy_from_slice(&value);
    }
    t
}

// ---------- BMP ----------

const BMP_V5: usize = 124;
/// `PROFILE_EMBEDDED` ('MBED') no campo `bV5CSType`.
const PROFILE_EMBEDDED: u32 = 0x4D42_4544;
const LCS_GM_IMAGES: u32 = 4;

fn le32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

/// BMP com cabeçalho BITMAPV5HEADER e o perfil ICC embutido depois dos pixels.
/// Aceita os cabeçalhos de 40 e 108 bytes que o codificador grava.
pub fn bmp_with_icc(bmp: &[u8], icc: &[u8]) -> Option<Vec<u8>> {
    if bmp.get(..2)? != b"BM" {
        return None;
    }
    let pix = le32(bmp, 10)? as usize;
    let hsize = le32(bmp, 14)? as usize;
    if !matches!(hsize, 40 | 108 | BMP_V5) || pix < 14 + hsize || pix > bmp.len() {
        return None;
    }
    let palette = &bmp[14 + hsize..pix];
    let pixels = &bmp[pix..];
    let new_pix = 14 + BMP_V5 + palette.len();
    let profile_at = new_pix + pixels.len();
    let total = u32::try_from(profile_at + icc.len()).ok()?;
    let mut header = bmp[14..14 + hsize].to_vec();
    header.resize(BMP_V5, 0);
    let mut set = |at: usize, v: u32| header[at..at + 4].copy_from_slice(&v.to_le_bytes());
    set(0, BMP_V5 as u32);
    set(56, PROFILE_EMBEDDED);
    set(108, LCS_GM_IMAGES);
    set(112, (profile_at - 14) as u32);
    set(116, icc.len() as u32);
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(b"BM");
    out.extend(total.to_le_bytes());
    out.extend([0; 4]);
    out.extend((new_pix as u32).to_le_bytes());
    out.extend(header);
    out.extend_from_slice(palette);
    out.extend_from_slice(pixels);
    out.extend_from_slice(icc);
    Some(out)
}

/// Perfil ICC embutido num BMP v5 (`PROFILE_EMBEDDED`).
pub fn bmp_icc(bmp: &[u8]) -> Option<Vec<u8>> {
    if bmp.get(..2)? != b"BM" || (le32(bmp, 14)? as usize) < BMP_V5 {
        return None;
    }
    if le32(bmp, 14 + 56)? != PROFILE_EMBEDDED {
        return None;
    }
    let off = 14 + le32(bmp, 14 + 112)? as usize;
    let size = le32(bmp, 14 + 116)? as usize;
    bmp.get(off..off.checked_add(size)?).map(<[u8]>::to_vec)
}

// ---------- ICC ----------

/// Perfil de espaço RGB: só esse descreve os pixels RGB que o app grava (um perfil CMYK ou
/// cinza num arquivo RGB deixaria as cores erradas em outros programas).
pub fn icc_is_rgb(icc: &[u8]) -> bool {
    icc.get(16..20) == Some(b"RGB ")
}

// ---------- XMP no JPEG ----------

pub const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
pub const XMP_EXT_NS: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
/// Maior payload de um segmento APPn (o tamanho de 16 bits conta os próprios 2 bytes).
const APP_MAX: usize = 65533;
/// Cabeçalho de cada segmento estendido: GUID (32) + tamanho total (4) + deslocamento (4).
const EXT_HEADER: usize = 40;

/// Payloads APP1 do XMP: um só, se couber; senão um pacote padrão mínimo que aponta
/// (`xmpNote:HasExtendedXMP` = MD5 do estendido) para o pacote inteiro, dividido em
/// segmentos de extensão (XMP Specification Part 3, 1.1.3.1).
pub fn jpeg_xmp_payloads(xmp: &str) -> Vec<Vec<u8>> {
    if XMP_NS.len() + xmp.len() <= APP_MAX {
        return vec![[XMP_NS, xmp.as_bytes()].concat()];
    }
    let ext = strip_xpacket(xmp).as_bytes();
    let guid = format!("{:X}", md5::compute(ext));
    let std = format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:xmpNote=\"http://ns.adobe.com/xmp/note/\" xmpNote:HasExtendedXMP=\"{guid}\"/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    );
    let mut out = vec![[XMP_NS, std.as_bytes()].concat()];
    let chunk = APP_MAX - XMP_EXT_NS.len() - EXT_HEADER;
    for (i, part) in ext.chunks(chunk).enumerate() {
        let mut p = Vec::with_capacity(XMP_EXT_NS.len() + EXT_HEADER + part.len());
        p.extend_from_slice(XMP_EXT_NS);
        p.extend_from_slice(guid.as_bytes());
        p.extend((ext.len() as u32).to_be_bytes());
        p.extend(((i * chunk) as u32).to_be_bytes());
        p.extend_from_slice(part);
        out.push(p);
    }
    out
}

/// Pacote sem as instruções `<?xpacket ...?>` do começo e do fim (o estendido não as leva).
fn strip_xpacket(x: &str) -> &str {
    let mut s = x.trim();
    if s.starts_with("<?xpacket")
        && let Some(e) = s.find("?>")
    {
        s = &s[e + 2..];
    }
    if let Some(b) = s.rfind("<?xpacket") {
        s = &s[..b];
    }
    s.trim()
}

/// GUID do XMP estendido anunciado no pacote padrão, e o trecho da marca a remover.
fn extended_guid(x: &str) -> Option<(String, std::ops::Range<usize>)> {
    let name = x.find("HasExtendedXMP")?;
    let start = x[..name].rfind(|c: char| c.is_whitespace() || c == '<')?;
    let element = x[start..].starts_with('<');
    let after = name + "HasExtendedXMP".len();
    let v = after + x[after..].find(|c: char| c.is_ascii_hexdigit())?;
    let guid = x.get(v..v + 32)?;
    if !guid.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let end = if element {
        v + x[v..].find('>')? + 1
    } else {
        v + 33 // GUID + aspas de fechamento
    };
    // Malformado (sem aspas depois do GUID, fim fora do texto ou no meio de um caractere).
    let quoted = element || matches!(x.as_bytes().get(v + 32), Some(b'"' | b'\''));
    if !quoted || end > x.len() || !x.is_char_boundary(end) {
        return None;
    }
    Some((guid.to_string(), start..end))
}

/// XMP do JPEG com o estendido reunido: as descrições do pacote estendido entram no padrão,
/// que perde a marca `HasExtendedXMP`. Sem estendido completo, o padrão volta como veio.
pub fn jpeg_merge_xmp(std: String, ext_payloads: &[&[u8]]) -> String {
    let Some((guid, mark)) = extended_guid(&std) else {
        return std;
    };
    // O tamanho declarado só vale se os dados recebidos puderem preenchê-lo.
    let available: usize = ext_payloads
        .iter()
        .map(|p| p.len().saturating_sub(XMP_EXT_NS.len() + EXT_HEADER))
        .sum();
    let mut full: Option<Vec<u8>> = None;
    let mut filled = 0usize;
    for p in ext_payloads {
        let Some(rest) = p.strip_prefix(XMP_EXT_NS) else {
            continue;
        };
        if rest.len() < EXT_HEADER || &rest[..32] != guid.as_bytes() {
            continue;
        }
        let total = (u32::from_be_bytes(rest[32..36].try_into().expect("4 bytes")) as usize)
            .min(MAX_VALUE);
        let off = u32::from_be_bytes(rest[36..40].try_into().expect("4 bytes")) as usize;
        let data = &rest[EXT_HEADER..];
        if total > available {
            return std;
        }
        let buf = full.get_or_insert_with(|| vec![0; total]);
        if let Some(dst) = off
            .checked_add(data.len())
            .and_then(|end| buf.get_mut(off..end))
        {
            dst.copy_from_slice(data);
            filled += data.len();
        }
    }
    let Some(buf) = full.filter(|b| filled >= b.len()) else {
        return std;
    };
    let ext = String::from_utf8_lossy(&buf);
    let body = ext
        .find("<rdf:RDF")
        .and_then(|a| Some(a + ext[a..].find('>')? + 1))
        .zip(ext.rfind("</rdf:RDF>"))
        .filter(|(a, b)| a <= b)
        .map(|(a, b)| &ext[a..b]);
    let (Some(body), Some(end)) = (body, std.rfind("</rdf:RDF>")) else {
        return std;
    };
    // Marca fora do RDF ou fatias inválidas: não é um pacote que saibamos juntar.
    let (Some(head), Some(mid), Some(tail)) = (
        std.get(..mark.start),
        std.get(mark.end..end).filter(|_| mark.end <= end),
        std.get(end..),
    ) else {
        return std;
    };
    [head, mid, body, tail].concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TIFF big-endian com Make (ASCII fora da entrada), um SHORT e um RATIONAL.
    fn tiff_be() -> Vec<u8> {
        let mut t = b"MM\0*\0\0\0\x08".to_vec();
        t.extend(3u16.to_be_bytes());
        let e = |t: &mut Vec<u8>, tag: u16, ty: u16, count: u32, v: [u8; 4]| {
            t.extend(tag.to_be_bytes());
            t.extend(ty.to_be_bytes());
            t.extend(count.to_be_bytes());
            t.extend(v);
        };
        let vals = 8 + 2 + 36 + 4;
        e(&mut t, 271, 2, 6, (vals as u32).to_be_bytes());
        e(&mut t, 274, 3, 1, [0, 6, 0, 0]);
        e(&mut t, 282, 5, 1, ((vals + 6) as u32).to_be_bytes());
        t.extend(0u32.to_be_bytes());
        t.extend(b"Canon\0");
        t.extend(72u32.to_be_bytes());
        t.extend(1u32.to_be_bytes());
        t
    }

    #[test]
    fn ifd_big_endian_relido_e_regravado_nos_dois_enderecamentos() {
        let t = tiff_be();
        let r = Reader::new(&t).unwrap();
        let es = r.read_ifd(8, 0).unwrap();
        assert_eq!(es[0].data, b"Canon\0");
        assert_eq!(es[1].data, 6u16.to_le_bytes());
        assert_eq!(es[2].data, [72u32.to_le_bytes(), 1u32.to_le_bytes()].concat());
        for le in [true, false] {
            let mut out = if le { b"II*\0\0\0\0\0".to_vec() } else { b"MM\0*\0\0\0\0".to_vec() };
            let off = write_ifd(&mut out, &es, le).unwrap();
            let p = if le { off.to_le_bytes() } else { off.to_be_bytes() };
            out[4..8].copy_from_slice(&p);
            let r2 = Reader::new(&out).unwrap();
            assert_eq!(r2.read_ifd(r2.ifd0().unwrap(), 0).unwrap(), es);
        }
    }

    #[test]
    fn ifd_corrompido_nao_panica() {
        let mut t = tiff_be();
        t[8..10].copy_from_slice(&900u16.to_be_bytes()); // mais entradas que bytes
        assert!(Reader::new(&t).unwrap().read_ifd(8, 0).is_some());
        assert_eq!(tiff_with_meta(b"II*\0\xff\xff\xff\xff", &TiffMeta::default()), None);
        assert_eq!(tiff_exif_block(b"lixo"), None);
        assert_eq!(exif_set_pixel_dims(b"II*\0\x08", (1, 1)), b"II*\0\x08");
    }

    /// IFD0 com um ponteiro EXIF para um sub-IFD de uma entrada `0xA002` cortada logo
    /// depois da contagem (o valor, em `e+8..e+12`, não existe).
    fn exif_truncado() -> Vec<u8> {
        let mut t = b"II*\0\x08\0\0\0".to_vec();
        t.extend(1u16.to_le_bytes());
        t.extend(TAG_EXIF_IFD.to_le_bytes());
        t.extend(4u16.to_le_bytes());
        t.extend(1u32.to_le_bytes());
        t.extend(26u32.to_le_bytes());
        t.extend(0u32.to_le_bytes());
        t.extend(1u16.to_le_bytes());
        t.extend(0xA002u16.to_le_bytes());
        t.extend(3u16.to_le_bytes());
        t.extend(1u32.to_le_bytes());
        t
    }

    #[test]
    fn exif_truncado_no_meio_do_pixel_x_nao_panica() {
        let t = exif_truncado();
        assert_eq!(exif_set_pixel_dims(&t, (5, 5)), t);
        assert_eq!(exif_set_pixel_dims(&t, (70_000, 5)), t, "SHORT que viraria LONG");
        assert!(tiff_exif_block(&t).is_some() || tiff_exif_block(&t).is_none());
    }

    /// Payload de extensão com o pacote `<rdf:RDF>X</rdf:RDF>` inteiro.
    fn ext_payload(guid: &str) -> Vec<u8> {
        let data = b"<rdf:RDF><rdf:Description/></rdf:RDF>";
        let mut p = XMP_EXT_NS.to_vec();
        p.extend(guid.as_bytes());
        p.extend((data.len() as u32).to_be_bytes());
        p.extend(0u32.to_be_bytes());
        p.extend(data);
        p
    }

    #[test]
    fn xmp_estendido_malformado_nao_panica() {
        let g = "0123456789ABCDEF0123456789ABCDEF";
        let ext = ext_payload(g);
        for std in [
            // `</rdf:RDF>` colado no GUID: a marca terminaria depois do fim do RDF.
            format!("<x><rdf:RDF><rdf:Description a:HasExtendedXMP=\"{g}</rdf:RDF></x>"),
            // `v+33` cai no meio de um caractere de 2 bytes.
            format!("<x><rdf:RDF><rdf:Description a:HasExtendedXMP=\"{g}é\"/></rdf:RDF></x>"),
            format!("<x><rdf:RDF><rdf:Description a:HasExtendedXMP=\"{g}"),
        ] {
            let out = jpeg_merge_xmp(std.clone(), &[&ext]);
            assert!(out == std || out.contains("<rdf:Description/>"), "{out}");
        }
    }

    #[test]
    fn total_do_estendido_nao_aloca_alem_dos_dados() {
        let g = "0123456789ABCDEF0123456789ABCDEF";
        let mut p = XMP_EXT_NS.to_vec();
        p.extend(g.as_bytes());
        p.extend(u32::MAX.to_be_bytes());
        p.extend(0u32.to_be_bytes());
        p.extend(b"x");
        let std = format!("<x><rdf:RDF><rdf:Description a:HasExtendedXMP=\"{g}\"/></rdf:RDF></x>");
        assert_eq!(jpeg_merge_xmp(std.clone(), &[&p]), std);
    }

    /// IFD LE em `at` com `n` entradas iguais.
    fn ifd_repetido(n: u16, tag: u16, ty: u16, count: u32, value: u32) -> Vec<u8> {
        let mut t = n.to_le_bytes().to_vec();
        for _ in 0..n {
            t.extend(tag.to_le_bytes());
            t.extend(ty.to_le_bytes());
            t.extend(count.to_le_bytes());
            t.extend(value.to_le_bytes());
        }
        t.extend(0u32.to_le_bytes());
        t
    }

    #[test]
    fn sub_ifds_repetidos_e_em_ciclo_ficam_no_orcamento() {
        // IFD0 e o sub-IFD com 1024 ponteiros EXIF para o mesmo sub-IFD (ciclo incluído).
        let sub_at = 8 + 2 + 12 * 1024 + 4;
        let mut t = b"II*\0\x08\0\0\0".to_vec();
        t.extend(ifd_repetido(1024, TAG_EXIF_IFD, 4, 1, sub_at as u32));
        t.extend(ifd_repetido(1024, TAG_EXIF_IFD, 4, 1, sub_at as u32));
        let started = std::time::Instant::now();
        let r = Reader::new(&t).unwrap();
        let es = r.read_ifd(8, 0).unwrap();
        let total = |es: &[Entry]| -> usize {
            fn walk(es: &[Entry]) -> usize {
                es.len() + es.iter().filter_map(|e| e.sub.as_deref()).map(walk).sum::<usize>()
            }
            walk(es)
        };
        assert!(total(&es) <= MAX_ENTRIES, "{} entradas", total(&es));
        assert!(started.elapsed().as_secs() < 2, "{:?}", started.elapsed());
        assert!(tiff_with_meta(&t, &TiffMeta::default()).is_some());
    }

    #[test]
    fn bytes_copiados_ficam_no_orcamento() {
        // 1024 entradas UNDEFINED de 1 MB apontando para o mesmo trecho: 1 GB sem teto.
        let mb = 1 << 20;
        let mut t = b"II*\0\x08\0\0\0".to_vec();
        let data_at = 8 + 2 + 12 * 1024 + 4;
        t.extend(ifd_repetido(1024, 0x9286, 7, mb, data_at as u32));
        t.resize(data_at + mb as usize, 0);
        let es = Reader::new(&t).unwrap().read_ifd(8, 0).unwrap();
        let bytes: usize = es.iter().map(|e| e.data.len()).sum();
        assert!(bytes <= MAX_TOTAL_BYTES, "{bytes} bytes");
    }

    #[test]
    fn bmp_v5_ida_e_volta() {
        let mut bmp = b"BM".to_vec();
        bmp.extend((14u32 + 40 + 8).to_le_bytes());
        bmp.extend([0; 4]);
        bmp.extend(54u32.to_le_bytes());
        let mut h = vec![0u8; 40];
        h[0..4].copy_from_slice(&40u32.to_le_bytes());
        bmp.extend(h);
        bmp.extend([1, 2, 3, 0, 4, 5, 6, 0]);
        let out = bmp_with_icc(&bmp, b"perfil").unwrap();
        assert_eq!(le32(&out, 10), Some(14 + 124));
        assert_eq!(&out[138..146], &[1, 2, 3, 0, 4, 5, 6, 0]);
        assert_eq!(bmp_icc(&out).as_deref(), Some(b"perfil".as_slice()));
        assert_eq!(le32(&out, 2), Some(out.len() as u32));
        assert_eq!(bmp_icc(&bmp), None);
        assert_eq!(bmp_with_icc(b"BMlixo", b"x"), None);
    }

    #[test]
    fn xmp_pequeno_fica_num_segmento_so() {
        let p = jpeg_xmp_payloads("<x/>");
        assert_eq!(p, vec![[XMP_NS, b"<x/>"].concat()]);
    }

    #[test]
    fn xmp_grande_vai_para_o_estendido_e_volta() {
        let corpo: String = (0..20_000).map(|i| format!("<a:b{i}>v</a:b{i}>")).collect();
        let xmp = format!(
            "<?xpacket begin=\"\"?><x:xmpmeta><rdf:RDF xmlns:rdf=\"r\"><rdf:Description rdf:about=\"\">{corpo}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
        );
        let p = jpeg_xmp_payloads(&xmp);
        assert!(p.len() >= 5 && p.iter().all(|s| s.len() <= APP_MAX));
        let std = String::from_utf8(p[0][XMP_NS.len()..].to_vec()).unwrap();
        let ext: Vec<&[u8]> = p[1..].iter().map(Vec::as_slice).collect();
        let merged = jpeg_merge_xmp(std.clone(), &ext);
        assert!(merged.contains("<a:b19999>v</a:b19999>"));
        assert!(!merged.contains("HasExtendedXMP"));
        // Extensão incompleta: fica só o padrão.
        assert_eq!(jpeg_merge_xmp(std.clone(), &ext[1..]), std);
    }

    #[test]
    fn guid_em_forma_de_elemento() {
        let g = "0123456789ABCDEF0123456789ABCDEF";
        let x = format!("<rdf:Description><xmpNote:HasExtendedXMP>{g}</xmpNote:HasExtendedXMP></rdf:Description>");
        let (guid, r) = extended_guid(&x).unwrap();
        assert_eq!(guid, g);
        assert_eq!(&x[r], format!("<xmpNote:HasExtendedXMP>{g}</xmpNote:HasExtendedXMP>"));
    }
}
