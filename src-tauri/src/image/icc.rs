//! Gerência de cor (Lote 1, o "ColorSync" do Pré-Visualização) com a `moxcms`, em Rust puro.
//!
//! O documento guarda os pixels no espaço do arquivo. Só o que vai para a tela (prévias e
//! miniaturas) é convertido do perfil da imagem para o perfil de exibição, e o Exportar converte
//! quando o usuário escolhe um perfil de saída. Os transforms ficam em cache por par de perfis;
//! um par equivalente à identidade (ex.: JPEG com o sRGB IEC61966-2.1 embutido) vira `None` e a
//! conversão é pulada, então o caminho comum não paga nada.
use super::raster::Raster;
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
    path::Path,
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

fn cms_err(e: impl std::fmt::Debug) -> AppError {
    AppError::Unsupported(format!("perfil de cor inválido: {e:?}"))
}

/// Perfil RGB legível pela `moxcms` (CMYK e cinza não descrevem os pixels RGBA do documento).
fn parse_rgb(bytes: &[u8]) -> Option<Icc> {
    Icc::new_from_slice(bytes)
        .ok()
        .filter(|p| p.color_space == DataColorSpace::Rgb)
}

pub fn is_rgb_profile(bytes: &[u8]) -> bool {
    parse_rgb(bytes).is_some()
}

/// Bytes ICC de um perfil pelo `id` de [`BUILTIN`] ou pelo caminho absoluto de um .icc/.icm.
/// Ficam em cache: o perfil atribuído é consultado a cada prévia.
pub fn profile_bytes(id: &str) -> AppResult<Arc<Vec<u8>>> {
    static CACHE: LazyLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = LazyLock::new(Default::default);
    if let Some(b) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        return Ok(b.clone());
    }
    let bytes = match builtin(id) {
        Some(p) => p.encode().map_err(cms_err)?,
        None => read_icc_file(Path::new(id))?,
    };
    let bytes = Arc::new(bytes);
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), bytes.clone());
    Ok(bytes)
}

fn read_icc_file(path: &Path) -> AppResult<Vec<u8>> {
    if !path.is_absolute() {
        return Err(AppError::Unsupported(format!(
            "perfil desconhecido: {}",
            path.display()
        )));
    }
    if std::fs::metadata(path)?.len() > MAX_ICC_BYTES {
        return Err(AppError::Unsupported("perfil de cor grande demais".into()));
    }
    let bytes = std::fs::read(path)?;
    if !is_rgb_profile(&bytes) {
        return Err(AppError::Unsupported(format!(
            "{} não é um perfil RGB",
            path.display()
        )));
    }
    Ok(bytes)
}

/// Bytes ICC do sRGB (o perfil presumido de imagens sem perfil).
pub fn srgb_icc() -> &'static [u8] {
    static B: OnceLock<Vec<u8>> = OnceLock::new();
    B.get_or_init(|| Icc::new_srgb().encode().unwrap_or_default())
}

/// Nome legível do perfil (tag `desc`).
pub fn describe(bytes: &[u8]) -> Option<String> {
    super::metadata::icc_description(bytes)
}

// ---------- Transforms ----------

fn digest(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

type Cached8 = Option<Arc<Transform8BitExecutor>>;

/// Até quantos pares de perfis ficam em cache (cada transform guarda algumas LUTs).
const MAX_TRANSFORMS: usize = 32;

fn options() -> TransformOptions {
    TransformOptions::default()
}

/// Transform RGBA8 de `src` para `dst`; `None` se algum perfil for ilegível ou se o par for
/// equivalente à identidade (nenhum canal muda mais de 1 nível numa grade de cores).
fn transform8(src: &[u8], dst: &[u8]) -> Cached8 {
    static CACHE: LazyLock<Mutex<HashMap<(u64, u64), Cached8>>> = LazyLock::new(Default::default);
    let key = (digest(src), digest(dst));
    if let Some(t) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return t.clone();
    }
    let t = parse_rgb(src)
        .zip(parse_rgb(dst))
        .and_then(|(s, d)| {
            s.create_transform_8bit(Layout::Rgba, &d, Layout::Rgba, options())
                .ok()
        })
        .filter(|t| !is_identity(t.as_ref()));
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= MAX_TRANSFORMS {
        cache.clear();
    }
    cache.insert(key, t.clone());
    t
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

/// Converte RGBA8 de `src` para `dst` no próprio buffer. Perfil ilegível: não mexe.
pub fn convert_rgba8(px: &mut [u8], src: &[u8], dst: &[u8]) {
    if let Some(t) = transform8(src, dst) {
        run_in_place(px, t.as_ref());
    }
}

fn run_in_place<V: Copy + Default + Send + Sync>(
    px: &mut [V],
    t: &(dyn moxcms::TransformExecutor<V> + Send + Sync),
) {
    px.par_chunks_mut(CHUNK_PX * 4).for_each(|chunk| {
        let src = chunk.to_vec();
        // `transform` só falha com tamanhos incoerentes, que aqui não acontecem.
        let _ = t.transform(&src, chunk);
    });
}

/// `img` convertida de `src` para `dst` (Exportar com perfil de saída); sem cópia se o par
/// for equivalente à identidade.
pub fn convert_raster<'a>(img: Raster<'a>, src: &[u8], dst: &[u8]) -> Raster<'a> {
    match img {
        Raster::Rgba8(i) => match transform8(src, dst) {
            Some(t) => {
                let mut i = i.into_owned();
                run_in_place(&mut i, t.as_ref());
                Raster::Rgba8(Cow::Owned(i))
            }
            None => Raster::Rgba8(i),
        },
        Raster::Rgba16(i) => {
            let mut i = i.into_owned();
            convert_rgba16(&mut i, src, dst);
            Raster::Rgba16(Cow::Owned(i))
        }
    }
}

/// Converte RGBA16 de `src` para `dst` (Exportar em 16 bits). Perfil ilegível: não mexe.
pub fn convert_rgba16(px: &mut [u16], src: &[u8], dst: &[u8]) {
    let Some(t) = parse_rgb(src).zip(parse_rgb(dst)).and_then(|(s, d)| {
        s.create_transform_16bit(Layout::Rgba, &d, Layout::Rgba, options())
            .ok()
    }) else {
        return;
    };
    run_in_place(px, t.as_ref());
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

/// Nome do perfil de exibição em uso; `None` = sRGB (ou correspondência desligada).
pub fn display_name() -> Option<String> {
    let d = DISPLAY.read().unwrap_or_else(|e| e.into_inner());
    d.target
        .as_deref()
        .filter(|_| !d.disabled)
        .map(|b| describe(b).unwrap_or_else(|| "ICC".into()))
}

/// Converte RGBA8 do perfil da imagem (`None` = sRGB) para o de exibição, no próprio buffer.
pub fn to_display(px: &mut [u8], src: Option<&[u8]>) {
    let d = DISPLAY.read().unwrap_or_else(|e| e.into_inner());
    if d.disabled {
        return;
    }
    let dst = d.target.as_deref().map_or(srgb_icc(), Vec::as_slice);
    match src {
        Some(s) => convert_rgba8(px, s, dst),
        None if d.target.is_some() => convert_rgba8(px, srgb_icc(), dst),
        None => {}
    }
}

// ---------- Perfil do monitor (colord) ----------

/// Perfil ICC do primeiro monitor com perfil no colord (`org.freedesktop.ColorManager`).
///
/// Só em sessão X11: no Wayland, KWin 6 e Mutter 48+ aplicam o perfil do monitor sobre a saída
/// sRGB dos apps, e converter aqui também aplicaria a correção duas vezes.
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
        if let Ok(bytes) = read_icc_file(Path::new(&file)) {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

// ---------- Perfis do sistema ----------

/// Perfis RGB instalados (`/usr/share/color/icc`, `~/.local/share/icc`, `~/.color/icc`):
/// `(caminho, nome)`, sem repetir nome, em ordem alfabética.
pub fn system_profiles() -> Vec<(String, String)> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut dirs = vec![
        std::path::PathBuf::from("/usr/share/color/icc"),
        std::path::PathBuf::from("/usr/local/share/color/icc"),
    ];
    if let Some(h) = home {
        dirs.push(h.join(".local/share/icc"));
        dirs.push(h.join(".color/icc"));
    }
    let mut found = Vec::new();
    for d in dirs {
        collect_icc(&d, 3, &mut found);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<(String, String)> = found
        .into_iter()
        .filter_map(|p| {
            let bytes = read_icc_file(&p).ok()?;
            let name = describe(&bytes).unwrap_or_else(|| {
                p.file_stem().map_or_else(String::new, |s| s.to_string_lossy().into_owned())
            });
            Some((p.to_string_lossy().into_owned(), name))
        })
        .filter(|(_, n)| !n.is_empty() && seen.insert(n.clone()))
        .collect();
    out.sort_by_key(|p| p.1.to_lowercase());
    out
}

fn collect_icc(dir: &Path, depth: u32, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                collect_icc(&p, depth - 1, out);
            }
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case("icc") || x.eq_ignore_ascii_case("icm"))
        {
            out.push(p);
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
        convert_rgba8(&mut px, &bytes(from), &bytes(to));
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
        convert_rgba8(&mut px[..4], &p3, srgb);
        let t = std::time::Instant::now();
        for _ in 0..10 {
            convert_rgba8(&mut px, &p3, srgb);
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
        assert!(transform8(&bytes(SRGB), srgb_icc()).is_none());
        assert!(transform8(&bytes("display-p3"), srgb_icc()).is_some());
        let mut px = vec![10, 20, 30, 40];
        convert_rgba8(&mut px, b"lixo", srgb_icc());
        assert_eq!(px, [10, 20, 30, 40], "perfil ilegível não mexe nos pixels");
    }

    #[test]
    fn conversao_em_blocos_cobre_o_buffer_inteiro() {
        let n = CHUNK_PX * 3 + 5;
        let mut px: Vec<u8> = [234, 51, 35, 255].repeat(n);
        convert_rgba8(&mut px, &bytes("display-p3"), srgb_icc());
        assert!(px.as_chunks::<4>().0.iter().all(|p| p[0] >= 253 && p[1] <= 2 && p[2] <= 2));
    }

    #[test]
    fn dezesseis_bits() {
        let mut px = [65535u16, 0, 0, 65535];
        convert_rgba16(&mut px, srgb_icc(), &bytes("display-p3"));
        let want = [234.0, 51.0, 35.0];
        for (c, w) in px[..3].iter().zip(want) {
            assert!((*c as f64 / 257.0 - w).abs() <= 2.0, "{px:?}");
        }
        assert_eq!(px[3], 65535);
    }

    #[test]
    fn perfis_desconhecidos_e_invalidos() {
        assert!(profile_bytes("relativo.icc").is_err());
        assert!(profile_bytes("/nao/existe.icc").is_err());
        let dir = std::env::temp_dir().join(format!("gvi-icc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ruim = dir.join("ruim.icc");
        std::fs::write(&ruim, b"nada").unwrap();
        assert!(profile_bytes(ruim.to_str().unwrap()).is_err());
        let bom = dir.join("p3.icc");
        std::fs::write(&bom, &*bytes("display-p3")).unwrap();
        assert_eq!(*bytes(bom.to_str().unwrap()), *bytes("display-p3"));
        std::fs::remove_dir_all(&dir).unwrap();
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
