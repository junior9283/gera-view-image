//! Gerência de cor (Lote 1, o "ColorSync" do Pré-Visualização) com a `moxcms`, em Rust puro.
//!
//! O documento guarda os pixels no espaço do arquivo. Só o que vai para a tela (prévias e
//! miniaturas) é convertido do perfil da imagem para o perfil de exibição, e o Exportar converte
//! quando o usuário escolhe um perfil de saída. Os transforms ficam em cache por par de perfis;
//! um par equivalente à identidade (ex.: JPEG com o sRGB IEC61966-2.1 embutido) vira `None` e a
//! conversão é pulada, então o caminho comum não paga nada.
use super::raster::Raster;
use ::image::RgbaImage;
use crate::error::{AppError, AppResult};
use moxcms::{
    ColorProfile as Icc, DataColorSpace, Layout, Transform8BitExecutor,
    TransformOptions,
};
use rayon::prelude::*;
use std::{
    borrow::Cow,
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    io::{Cursor, Read},
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, OnceLock, RwLock},
};

pub const SRGB: &str = "srgb";

/// Perfis embutidos oferecidos em Atribuir Perfil… e no Exportar: `(id, nome)`.
pub const BUILTIN: [(&str, &str); 5] = [
    (SRGB, "sRGB IEC61966-2.1"),
    ("display-p3", "Display P3"),
    ("adobe-rgb", "Adobe RGB (1998)"),
    ("prophoto-rgb", "ProPhoto RGB"),
    ("rec2020", "Rec. ITU-R BT.2020"),
];

/// Maior arquivo .icc aceito (perfis de impressora com LUTs grandes passam de 1 MB).
const MAX_ICC_BYTES: u64 = 16 << 20;

fn builtin(id: &str) -> Option<Icc> {
    Some(match id {
        SRGB => Icc::new_srgb(),
        "display-p3" => Icc::new_display_p3(),
        "adobe-rgb" => Icc::new_adobe_rgb(),
        "prophoto-rgb" => Icc::new_pro_photo_rgb(),
        "rec2020" => Icc::new_bt2020(),
        _ => return None,
    })
}

/// Perfis vêm de arquivos não confiáveis: um pânico da `moxcms` vira `None`.
pub(super) fn guard<T>(f: impl FnOnce() -> T) -> Option<T> {
    catch_unwind(AssertUnwindSafe(f)).ok()
}

/// Perfil de qualquer espaço, legível pela `moxcms`.
pub(super) fn parse(bytes: &[u8]) -> Option<Icc> {
    if bytes.len() as u64 > MAX_ICC_BYTES {
        return None;
    }
    guard(|| Icc::new_from_slice(bytes).ok())?
}

/// Só RGB (CMYK e cinza não descrevem os pixels RGBA do documento).
pub(super) fn parse_rgb(bytes: &[u8]) -> Option<Icc> {
    parse(bytes).filter(|p| p.color_space == DataColorSpace::Rgb)
}

pub fn is_rgb_profile(bytes: &[u8]) -> bool {
    parse_rgb(bytes).is_some()
}

static PROFILES: LazyLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = LazyLock::new(Default::default);

/// Perfil já carregado por [`profile_bytes`], ou um de [`BUILTIN`]. Nunca lê o disco, então
/// pode ser chamado com a trava dos documentos.
pub fn known_profile(id: &str) -> Option<Arc<Vec<u8>>> {
    if let Some(b) = PROFILES.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        return Some(b.clone());
    }
    let bytes = guard(|| builtin(id)?.encode().ok())??;
    Some(remember(id, bytes))
}

fn remember(id: &str, bytes: Vec<u8>) -> Arc<Vec<u8>> {
    PROFILES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(bytes))
        .clone()
}

/// Bytes ICC de um perfil pelo `id` de [`BUILTIN`] ou pelo caminho de um .icc/.icm dentro das
/// pastas de perfis do sistema (o `id` vem da interface: outro caminho é recusado). Lê o disco
/// na primeira vez: não chamar com a trava dos documentos.
pub fn profile_bytes(id: &str) -> AppResult<Arc<Vec<u8>>> {
    if let Some(b) = known_profile(id) {
        return Ok(b);
    }
    let bytes = read_profile(Path::new(id), &profile_dirs(), is_rgb_profile)?;
    if !convertible(&bytes, srgb_icc()) {
        return Err(bad_profile(Path::new(id)));
    }
    Ok(remember(id, bytes))
}

fn bad_profile(path: &Path) -> AppError {
    AppError::Unsupported(format!("perfil de cor inválido: {}", path.display()))
}

/// Pastas de perfis: do sistema, do colord e do usuário.
fn profile_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/color/icc"),
        PathBuf::from("/usr/local/share/color/icc"),
        PathBuf::from("/var/lib/colord/icc"),
    ];
    if let Some(h) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(h.join(".local/share/icc"));
        dirs.push(h.join(".color/icc"));
    }
    dirs
}

fn has_icc_extension(p: &Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| x.eq_ignore_ascii_case("icc") || x.eq_ignore_ascii_case("icm"))
}

/// Que perfis servem (ver [`is_rgb_profile`]).
pub(super) type Accept = fn(&[u8]) -> bool;

/// Lê um perfil de dentro de `dirs` (já sem links simbólicos). Todo erro é igual, para não dizer
/// à interface o que existe fora das pastas.
fn read_profile(path: &Path, dirs: &[PathBuf], accept: Accept) -> AppResult<Vec<u8>> {
    let inside = |real: &Path| {
        dirs.iter().filter_map(|d| d.canonicalize().ok()).any(|d| real.starts_with(d))
    };
    read_icc(path, inside, accept).ok_or_else(|| bad_profile(path))
}

/// Lê um perfil que o usuário escolheu, de qualquer pasta, com os mesmos cuidados.
pub(super) fn read_chosen(path: &Path, accept: Accept) -> AppResult<Vec<u8>> {
    read_icc(path, |_| true, accept).ok_or_else(|| bad_profile(path))
}

/// Só arquivo regular, .icc/.icm e até `MAX_ICC_BYTES`: FIFO não trava (`O_NONBLOCK`) e
/// dispositivo é recusado pelo `fstat`.
fn read_icc(path: &Path, inside: impl Fn(&Path) -> bool, accept: Accept) -> Option<Vec<u8>> {
    if !path.is_absolute() {
        return None;
    }
    let real = path.canonicalize().ok()?;
    if !inside(&real) || !has_icc_extension(&real) {
        return None;
    }
    let f = crate::fsio::open_regular_with(&real, libc::O_NOFOLLOW).ok()?;
    let mut bytes = Vec::new();
    f.take(MAX_ICC_BYTES + 1).read_to_end(&mut bytes).ok()?;
    accept(&bytes).then_some(bytes)
}

/// Bytes ICC do sRGB (o perfil presumido de imagens sem perfil).
pub fn srgb_icc() -> &'static [u8] {
    static B: OnceLock<Vec<u8>> = OnceLock::new();
    B.get_or_init(|| known_profile(SRGB).map_or_else(Vec::new, |b| b.to_vec()))
}

/// Nome legível do perfil (tag `desc`).
pub fn describe(bytes: &[u8]) -> Option<String> {
    super::metadata::icc_description(bytes)
}

// ---------- Transforms ----------

pub(super) fn digest(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Como levar pixels RGBA8 de um perfil a outro.
#[derive(Clone)]
enum Conversion {
    /// Nenhum canal muda mais de 1 nível numa grade de cores: a conversão é pulada.
    Identity,
    Run(Arc<Transform8BitExecutor>),
    /// Perfil ilegível ou par sem transform.
    Failed,
}

/// Até quantos pares de perfis ficam em cache (cada transform guarda algumas LUTs).
const MAX_TRANSFORMS: usize = 32;

fn conversion(src: &[u8], dst: &[u8]) -> Conversion {
    static CACHE: LazyLock<Mutex<HashMap<(u64, u64), Conversion>>> =
        LazyLock::new(Default::default);
    if src == dst {
        return Conversion::Identity;
    }
    let key = (digest(src), digest(dst));
    if let Some(c) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return c.clone();
    }
    let built = guard(|| {
        let (s, d) = parse_rgb(src).zip(parse_rgb(dst))?;
        let t = s
            .create_transform_8bit(Layout::Rgba, &d, Layout::Rgba, TransformOptions::default())
            .ok()?;
        Some(if is_identity(t.as_ref()) {
            Conversion::Identity
        } else {
            Conversion::Run(t)
        })
    });
    let c = built.flatten().unwrap_or(Conversion::Failed);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= MAX_TRANSFORMS {
        cache.clear();
    }
    cache.insert(key, c.clone());
    c
}

/// Há conversão de `src` para `dst` (inclusive a identidade).
pub fn convertible(src: &[u8], dst: &[u8]) -> bool {
    !matches!(conversion(src, dst), Conversion::Failed)
}

fn is_identity(t: &Transform8BitExecutor) -> bool {
    const STEPS: [u8; 9] = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    let probe: Vec<u8> = STEPS
        .iter()
        .flat_map(|&r| STEPS.iter().flat_map(move |&g| STEPS.iter().map(move |&b| [r, g, b, 255])))
        .flatten()
        .collect();
    let mut out = vec![0u8; probe.len()];
    t.transform(&probe, &mut out).is_ok()
        && probe.iter().zip(&out).all(|(a, b)| a.abs_diff(*b) <= 1)
}

/// Pixels por bloco nas conversões em paralelo (cabe no cache L2 junto com a cópia).
const CHUNK_PX: usize = 16 * 1024;

/// Converte RGBA8 de `src` para `dst` no próprio buffer; `false` se não deu (perfil ilegível).
#[must_use]
pub fn convert_rgba8(px: &mut [u8], src: &[u8], dst: &[u8]) -> bool {
    match conversion(src, dst) {
        Conversion::Identity => true,
        Conversion::Run(t) => run_in_place(px, t.as_ref()),
        Conversion::Failed => false,
    }
}

fn run_in_place<V: Copy + Default + Send + Sync>(
    px: &mut [V],
    t: &(dyn moxcms::TransformExecutor<V> + Send + Sync),
) -> bool {
    px.par_chunks_mut(CHUNK_PX * 4)
        .map(|chunk| {
            let src = chunk.to_vec();
            let ok = guard(|| t.transform(&src, chunk).is_ok()).unwrap_or(false);
            if !ok {
                chunk.copy_from_slice(&src);
            }
            ok
        })
        .reduce(|| true, |a, b| a && b)
}

/// Converte RGBA16 de `src` para `dst`; `false` se não deu.
#[must_use]
pub fn convert_rgba16(px: &mut [u16], src: &[u8], dst: &[u8]) -> bool {
    if src == dst {
        return true;
    }
    let t = guard(|| {
        let (s, d) = parse_rgb(src).zip(parse_rgb(dst))?;
        s.create_transform_16bit(Layout::Rgba, &d, Layout::Rgba, TransformOptions::default())
            .ok()
    });
    t.flatten().is_some_and(|t| run_in_place(px, t.as_ref()))
}

/// `img` convertida de `src` para `dst` (Salvar/Exportar); sem cópia se for identidade.
/// Erro em vez de pixels não convertidos: o arquivo levaria um perfil que não os descreve.
pub fn convert_raster<'a>(img: Raster<'a>, src: &[u8], dst: &[u8]) -> AppResult<Raster<'a>> {
    let (out, ok) = match img {
        Raster::Rgba8(i) => match conversion(src, dst) {
            Conversion::Identity => (Raster::Rgba8(i), true),
            Conversion::Failed => (Raster::Rgba8(i), false),
            Conversion::Run(t) => {
                let mut i = i.into_owned();
                let ok = run_in_place(&mut i, t.as_ref());
                (Raster::Rgba8(Cow::Owned(i)), ok)
            }
        },
        Raster::Rgba16(i) => {
            let mut i = i.into_owned();
            let ok = convert_rgba16(&mut i, src, dst);
            (Raster::Rgba16(Cow::Owned(i)), ok)
        }
    };
    ok.then_some(out)
        .ok_or_else(|| AppError::Unsupported("não foi possível converter o perfil de cor".into()))
}

/// `img` do perfil `doc` (`None` = sRGB) para sRGB, o espaço do que sai do app sem perfil (área
/// de transferência, arraste, impressão). Sem cópia se já for sRGB; perfil ilegível: como está.
pub fn to_srgb<'a>(img: Cow<'a, RgbaImage>, doc: Option<&[u8]>) -> Cow<'a, RgbaImage> {
    match doc.map(|d| conversion(d, srgb_icc())) {
        Some(Conversion::Run(t)) => {
            let mut i = img.into_owned();
            run_in_place(&mut i, t.as_ref());
            Cow::Owned(i)
        }
        _ => img,
    }
}

// ---------- Exibição ----------

/// Para onde vão os pixels da tela.
#[derive(Debug, Clone, Default, PartialEq)]
struct Display {
    disabled: bool,
    /// Perfil do monitor; `None` = sRGB (o espaço que o WebView e o compositor assumem).
    target: Option<Arc<Vec<u8>>>,
}

static DISPLAY: LazyLock<RwLock<Display>> = LazyLock::new(Default::default);

/// Liga/desliga a correspondência de cor e define o perfil do monitor (`None` = sRGB).
/// Devolve se algo mudou (as prévias precisam ser refeitas).
pub fn configure(enabled: bool, monitor: Option<Vec<u8>>) -> bool {
    let next = Display {
        disabled: !enabled,
        target: monitor.filter(|b| is_rgb_profile(b)).map(Arc::new),
    };
    let mut d = DISPLAY.write().unwrap_or_else(|e| e.into_inner());
    let changed = *d != next;
    *d = next;
    changed
}

/// A correspondência de cor está ligada. Desligada, tudo é mostrado e copiado como sRGB.
pub fn enabled() -> bool {
    !display().disabled
}

/// Nome do perfil de exibição em uso; `None` = sRGB (ou correspondência desligada).
pub fn display_name() -> Option<String> {
    let d = DISPLAY.read().unwrap_or_else(|e| e.into_inner());
    d.target
        .as_deref()
        .filter(|_| !d.disabled)
        .map(|b| describe(b).unwrap_or_else(|| "ICC".into()))
}

/// Perfis `(imagem, tela)` de uma conversão; `None` quando não há o que converter. Copia o alvo
/// para não segurar a trava durante o trabalho no rayon.
fn screen_pair<'a>(
    doc: Option<&'a [u8]>,
    target: &'a Option<Arc<Vec<u8>>>,
) -> Option<(&'a [u8], &'a [u8])> {
    (doc.is_some() || target.is_some()).then(|| {
        let srgb = srgb_icc();
        (doc.unwrap_or(srgb), target.as_deref().map_or(srgb, Vec::as_slice))
    })
}

fn display() -> Display {
    DISPLAY.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Perfil de exibição em uso; `None` = correspondência de cor desligada.
pub(super) fn screen_icc() -> Option<Arc<Vec<u8>>> {
    let d = display();
    (!d.disabled).then(|| d.target.unwrap_or_else(|| Arc::new(srgb_icc().to_vec())))
}

/// Converte RGBA8 do perfil da imagem (`None` = sRGB) para o de exibição, no próprio buffer.
/// Perfil ilegível: os pixels ficam como estão.
pub fn to_display(px: &mut [u8], doc: Option<&[u8]>) {
    let d = display();
    if let Some((doc, screen)) = screen_pair(doc, &d.target).filter(|_| !d.disabled) {
        let _ = convert_rgba8(px, doc, screen);
    }
}

/// PNG desenhado pela interface (cores de tela) levado ao perfil da imagem, o inverso de
/// [`to_display`]. `None` = usar o PNG como está.
pub fn png_from_display(png: &[u8], doc: Option<&[u8]>) -> Option<Vec<u8>> {
    use ::image::{
        ExtendedColorType, ImageEncoder, ImageFormat,
        codecs::png::{CompressionType, FilterType, PngEncoder},
    };
    let d = display();
    let (doc, screen) = screen_pair(doc, &d.target).filter(|_| !d.disabled)?;
    if !matches!(conversion(screen, doc), Conversion::Run(_)) {
        return None;
    }
    let mut img = ::image::load_from_memory_with_format(png, ImageFormat::Png)
        .ok()?
        .into_rgba8();
    if !convert_rgba8(&mut img, screen, doc) {
        return None;
    }
    let mut out = Cursor::new(Vec::new());
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(&img, img.width(), img.height(), ExtendedColorType::Rgba8)
        .ok()?;
    Some(out.into_inner())
}

// ---------- Perfil do monitor (colord) ----------

/// Perfil ICC do primeiro monitor com perfil no colord (`org.freedesktop.ColorManager`).
///
/// Só em sessão X11: no Wayland a correção do monitor é do compositor (que trata a saída dos
/// apps como sRGB), e converter aqui também poderia aplicá-la duas vezes.
pub fn monitor_profile() -> Option<Vec<u8>> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return None;
    }
    colord_display_icc().ok().flatten()
}

fn colord_display_icc() -> zbus::Result<Option<Vec<u8>>> {
    use zbus::{blocking::Proxy, zvariant::OwnedObjectPath};
    const DEST: &str = "org.freedesktop.ColorManager";
    let conn = zbus::blocking::Connection::system()?;
    let cm = Proxy::new(&conn, DEST, "/org/freedesktop/ColorManager", DEST)?;
    let devices: Vec<OwnedObjectPath> = cm.call("GetDevicesByKind", &("display",))?;
    for dev in devices {
        let dev = Proxy::new(&conn, DEST, dev, "org.freedesktop.ColorManager.Device")?;
        let profiles: Vec<OwnedObjectPath> = dev.get_property("Profiles").unwrap_or_default();
        let Some(first) = profiles.into_iter().next() else {
            continue;
        };
        let p = Proxy::new(&conn, DEST, first, "org.freedesktop.ColorManager.Profile")?;
        let file: String = p.get_property("Filename").unwrap_or_default();
        if let Ok(bytes) = read_profile(Path::new(&file), &profile_dirs(), is_rgb_profile) {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

// ---------- Perfis do sistema ----------

/// Perfis RGB instalados (ver `profile_dirs`): `(caminho, nome)`, sem repetir nome, em ordem
/// alfabética.
pub fn system_profiles() -> Vec<(String, String)> {
    system_profiles_where(is_rgb_profile)
}

/// Como [`system_profiles`], com os perfis que `accept` aprovar.
pub(super) fn system_profiles_where(accept: Accept) -> Vec<(String, String)> {
    profiles_in(&profile_dirs(), accept)
}

fn profiles_in(dirs: &[PathBuf], accept: Accept) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for d in dirs {
        collect_icc(d, 3, &mut found);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<(String, String)> = found
        .into_iter()
        .filter_map(|p| {
            let bytes = read_profile(&p, dirs, accept).ok()?;
            let name = describe(&bytes).unwrap_or_else(|| {
                p.file_stem().map_or_else(String::new, |s| s.to_string_lossy().into_owned())
            });
            Some((p.to_str()?.to_string(), name))
        })
        .filter(|(_, n)| !n.is_empty() && seen.insert(n.clone()))
        .collect();
    out.sort_by_key(|p| p.1.to_lowercase());
    out
}

fn collect_icc(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for p in rd.flatten().map(|e| e.path()) {
        if has_icc_extension(&p) {
            out.push(p);
        } else if depth > 0 && p.is_dir() {
            collect_icc(&p, depth - 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(id: &str) -> Arc<Vec<u8>> {
        profile_bytes(id).unwrap()
    }

    fn convert(rgb: [u8; 3], from: &str, to: &str) -> [u8; 3] {
        let mut px = [rgb[0], rgb[1], rgb[2], 200];
        assert!(convert_rgba8(&mut px, &bytes(from), &bytes(to)));
        assert_eq!(px[3], 200, "o alfa passa intacto");
        [px[0], px[1], px[2]]
    }

    #[track_caller]
    fn near(got: [u8; 3], want: [u8; 3]) {
        let ok = got.iter().zip(want).all(|(g, w)| g.abs_diff(w) <= 2);
        assert!(ok, "obtido {got:?}, esperado {want:?} (±2)");
    }

    // Valores de referência calculados com as matrizes das especificações (primárias e branco
    // D65; ProPhoto em D50 adaptado por Bradford) e as curvas de cada espaço.
    #[test]
    fn conversoes_com_valores_conhecidos() {
        near(convert([255, 0, 0], SRGB, "display-p3"), [234, 51, 35]);
        near(convert([234, 51, 35], "display-p3", SRGB), [255, 0, 0]);
        near(convert([200, 100, 50], "display-p3", SRGB), [215, 93, 31]);
        near(convert([0, 255, 0], SRGB, "adobe-rgb"), [144, 255, 60]);
        near(convert([255, 0, 0], SRGB, "adobe-rgb"), [219, 0, 0]);
        near(convert([200, 100, 50], "adobe-rgb", SRGB), [227, 100, 42]);
        near(convert([200, 100, 50], "prophoto-rgb", SRGB), [255, 80, 47]);
        near(convert([100, 150, 200], "prophoto-rgb", SRGB), [0, 175, 216]);
    }

    /// Custo da conversão de uma prévia de tela 2560x1440 (rode com `--ignored --nocapture`).
    #[test]
    #[ignore]
    fn tempo_da_conversao_de_uma_previa() {
        let mut px: Vec<u8> = (0..2560 * 1440 * 4).map(|i| (i * 7 % 251) as u8).collect();
        let (p3, srgb) = (bytes("display-p3"), srgb_icc());
        assert!(convert_rgba8(&mut px[..4], &p3, srgb));
        let t = std::time::Instant::now();
        for _ in 0..10 {
            assert!(convert_rgba8(&mut px, &p3, srgb));
        }
        eprintln!("P3 → sRGB, 3,7 MP: {:?} por quadro", t.elapsed() / 10);
    }

    #[test]
    fn vermelho_p3_satura_no_srgb() {
        near(convert([255, 0, 0], "display-p3", SRGB), [255, 0, 0]);
    }

    #[test]
    fn cinza_neutro_continua_cinza() {
        for id in ["display-p3", "adobe-rgb", "prophoto-rgb"] {
            let g = convert([128, 128, 128], id, SRGB);
            assert!(g[0].abs_diff(g[1]) <= 1 && g[1].abs_diff(g[2]) <= 1, "{id}: {g:?}");
        }
        near(convert([128, 128, 128], "display-p3", SRGB), [128, 128, 128]);
    }

    #[test]
    fn par_equivalente_vira_identidade() {
        let p3 = bytes("display-p3");
        assert!(matches!(conversion(&bytes(SRGB), srgb_icc()), Conversion::Identity));
        assert!(matches!(conversion(&p3, srgb_icc()), Conversion::Run(_)));
        let mut px = vec![10, 20, 30, 40];
        assert!(!convert_rgba8(&mut px, b"lixo", srgb_icc()));
        assert_eq!(px, [10, 20, 30, 40], "perfil ilegível não mexe nos pixels");
    }

    #[test]
    fn conversao_em_blocos_cobre_o_buffer_inteiro() {
        let n = CHUNK_PX * 3 + 5;
        let mut px: Vec<u8> = [234, 51, 35, 255].repeat(n);
        assert!(convert_rgba8(&mut px, &bytes("display-p3"), srgb_icc()));
        assert!(px.as_chunks::<4>().0.iter().all(|p| p[0] >= 253 && p[1] <= 2 && p[2] <= 2));
    }

    #[test]
    fn dezesseis_bits() {
        let mut px = [65535u16, 0, 0, 65535];
        assert!(convert_rgba16(&mut px, srgb_icc(), &bytes("display-p3")));
        let want = [234.0, 51.0, 35.0];
        for (c, w) in px[..3].iter().zip(want) {
            assert!((*c as f64 / 257.0 - w).abs() <= 2.0, "{px:?}");
        }
        assert_eq!(px[3], 65535);
    }

    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Self {
            let d = std::env::temp_dir().join(format!("gvi-icc-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Dir(d)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn so_le_perfis_das_pastas_permitidas() {
        let (dir, fora) = (Dir::new("dentro"), Dir::new("fora"));
        let dirs = [dir.0.clone()];
        let p3 = bytes("display-p3");
        let put = |p: PathBuf| {
            std::fs::write(&p, &*p3).unwrap();
            p
        };
        let bom = put(dir.0.join("p3.icc"));
        let secreto = put(fora.0.join("p3.icc"));
        let ruim = dir.0.join("ruim.icc");
        std::fs::write(&ruim, b"nada").unwrap();
        let link = dir.0.join("link.icc");
        std::os::unix::fs::symlink(&secreto, &link).unwrap();
        let pasta = dir.0.join("pasta.icc");
        std::fs::create_dir(&pasta).unwrap();
        let grande = dir.0.join("grande.icc");
        std::fs::File::create(&grande).unwrap().set_len(MAX_ICC_BYTES + 1).unwrap();
        let fifo = dir.0.join("fifo.icc");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: caminho válido terminado em NUL.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);

        let read_profile = |p: &Path, d: &[PathBuf]| super::read_profile(p, d, is_rgb_profile);
        assert_eq!(read_profile(&bom, &dirs).unwrap(), **p3);
        let sobe = dir.0.join("..").join(fora.0.file_name().unwrap()).join("p3.icc");
        let sem_ext = put(dir.0.join("p3.txt"));
        for p in [&secreto, &ruim, &link, &pasta, &grande, &fifo, &sobe, &sem_ext] {
            assert!(read_profile(p, &dirs).is_err(), "{}", p.display());
        }
        for p in ["relativo.icc", "/nao/existe.icc", "/dev/zero", "/etc/passwd"] {
            assert!(read_profile(Path::new(p), &dirs).is_err(), "{p}");
            assert!(profile_bytes(p).is_err(), "{p}");
        }
        assert!(profile_bytes(bom.to_str().unwrap()).is_err(), "fora das pastas do sistema");
        let nomes = profiles_in(&dirs, is_rgb_profile);
        assert_eq!(nomes.len(), 1, "{nomes:?}");
        assert_eq!(nomes[0].0, bom.to_str().unwrap());
    }

    /// Perfis truncados e adulterados nunca derrubam o app nem mexem no alfa.
    #[test]
    fn icc_truncado_e_adulterado_nao_panica() {
        for id in ["display-p3", "adobe-rgb"] {
            let good = bytes(id);
            // Um byte por vez; em 16 bits (LUTs grandes), só uma amostra.
            let try_it = |i: usize, b: &[u8]| {
                let mut px = [200u8, 100, 50, 77, 1, 2, 3, 4];
                let _ = convert_rgba8(&mut px, b, srgb_icc());
                assert_eq!((px[3], px[7]), (77, 4));
                if !i.is_multiple_of(8) {
                    return;
                }
                let mut px = [60000u16, 100, 50, 777];
                let _ = convert_rgba16(&mut px, srgb_icc(), b);
                assert_eq!(px[3], 777);
            };
            for n in 0..good.len() {
                try_it(n, &good[..n]);
            }
            for i in 0..good.len() {
                for v in [0x00, 0xFF] {
                    let mut b = good.to_vec();
                    b[i] = v;
                    try_it(i, &b);
                }
            }
        }
    }

    #[test]
    fn exportar_com_perfil_ilegivel_da_erro() {
        let img = ::image::RgbaImage::from_pixel(1, 1, ::image::Rgba([1, 2, 3, 255]));
        assert!(convert_raster((&img).into(), b"lixo", srgb_icc()).is_err());
    }

    /// Estado padrão da exibição: sRGB. Imagem sem perfil fica como está; P3 é convertida.
    #[test]
    fn exibicao_padrao_em_srgb() {
        let mut px = vec![200, 100, 50, 255];
        to_display(&mut px, None);
        assert_eq!(px, [200, 100, 50, 255]);
        to_display(&mut px, Some(&bytes("display-p3")));
        near([px[0], px[1], px[2]], [215, 93, 31]);
        assert_eq!(display_name(), None);
        assert!(png_from_display(b"nem chega a ler", None).is_none());
    }

    #[test]
    fn perfis_embutidos_tem_nome() {
        for (id, _) in BUILTIN {
            let b = bytes(id);
            assert!(is_rgb_profile(&b), "{id}");
            assert!(describe(&b).is_some_and(|n| !n.is_empty()), "{id}");
        }
    }
}
