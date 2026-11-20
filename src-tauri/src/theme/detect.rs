//! Detecta o tema da janela (botões, estilo do decorador, claro/escuro, destaque, ícones).
//! Toda a leitura do sistema passa por [`DesktopEnv`], para ser falsificável nos testes.
use super::layout::{
    GNOME_DEFAULT, KDE_DEFAULT_LEFT, KDE_DEFAULT_RIGHT, ButtonLayout, parse_gnome, parse_kwin,
};
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DecorationStyle {
    Breeze,
    Adwaita,
    Elementary,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ButtonIcons {
    pub close: String,
    pub minimize: String,
    pub maximize: String,
    pub restore: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WmColors {
    pub active_bg: String,
    pub active_fg: String,
    pub inactive_bg: String,
    pub inactive_fg: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowTheme {
    pub layout: ButtonLayout,
    pub style: DecorationStyle,
    pub dark: bool,
    /// `#rrggbb`
    pub accent: Option<String>,
    pub icons: Option<ButtonIcons>,
    pub colors: Option<WmColors>,
}

/// Tudo o que o detector lê do sistema.
pub trait DesktopEnv {
    fn var(&self, key: &str) -> Option<String>;
    /// Conteúdo bruto de um arquivo.
    fn read(&self, path: &Path) -> Option<Vec<u8>>;
    /// Entradas de um diretório (vazio se não for diretório).
    fn list_dir(&self, path: &Path) -> Vec<PathBuf>;
    /// `gsettings get` (valor cru, com aspas simples se for texto).
    fn gsettings(&self, schema: &str, key: &str) -> Option<String>;
    /// `org.freedesktop.appearance color-scheme`: 0 sem preferência, 1 escuro, 2 claro.
    fn portal_color_scheme(&self) -> Option<u32>;
    /// `org.freedesktop.appearance accent-color` já como `#rrggbb`.
    fn portal_accent(&self) -> Option<String>;
}

fn read_string(env: &dyn DesktopEnv, path: &Path) -> Option<String> {
    String::from_utf8(env.read(path)?).ok()
}

fn unquote(s: &str) -> &str {
    s.trim().trim_matches('\'').trim_matches('"')
}

fn gsetting(env: &dyn DesktopEnv, schema: &str, key: &str) -> Option<String> {
    let v = env.gsettings(schema, key)?;
    let v = unquote(&v);
    (!v.is_empty()).then(|| v.to_string())
}

fn home(env: &dyn DesktopEnv) -> PathBuf {
    PathBuf::from(env.var("HOME").unwrap_or_default())
}

pub fn config_home(env: &dyn DesktopEnv) -> PathBuf {
    env.var("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home(env).join(".config"))
}

fn data_home(env: &dyn DesktopEnv) -> PathBuf {
    env.var("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home(env).join(".local/share"))
}

fn icon_dirs(env: &dyn DesktopEnv) -> Vec<PathBuf> {
    let mut dirs = vec![home(env).join(".icons"), data_home(env).join("icons")];
    let xdg = env
        .var("XDG_DATA_DIRS")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    dirs.extend(xdg.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join("icons")));
    dirs
}

/// Valor de `[section] key` num arquivo INI do KDE.
fn ini_get(text: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_section = name == section;
        } else if in_section {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == key {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

/// `"r,g,b"` (também aceita `r,g,b,a`) -> `#rrggbb`.
fn rgb_csv_to_hex(s: &str) -> Option<String> {
    let mut it = s.split(',').map(|p| p.trim().parse::<u8>());
    let (r, g, b) = (it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?);
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

fn luminance_is_dark(csv: &str) -> Option<bool> {
    let mut it = csv.split(',').map(|p| p.trim().parse::<f32>());
    let (r, g, b) = (it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?);
    Some((0.2126 * r + 0.7152 * g + 0.0722 * b) < 128.0)
}

fn kde_colors(kdeglobals: &str) -> Option<WmColors> {
    let c = |k: &str| ini_get(kdeglobals, "WM", k).and_then(|v| rgb_csv_to_hex(&v));
    Some(WmColors {
        active_bg: c("activeBackground")?,
        active_fg: c("activeForeground")?,
        inactive_bg: c("inactiveBackground")?,
        inactive_fg: c("inactiveForeground")?,
    })
}

// ---------- ícones ----------

fn find_file(env: &dyn DesktopEnv, root: &Path, names: &[String], depth: u32) -> Option<PathBuf> {
    let entries = env.list_dir(root);
    if let Some(hit) = entries
        .iter()
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| names.iter().any(|w| w == n)))
    {
        return Some(hit.clone());
    }
    if depth == 0 {
        return None;
    }
    entries.iter().find_map(|p| find_file(env, p, names, depth - 1))
}

fn theme_chain(env: &dyn DesktopEnv, dirs: &[PathBuf], first: &str) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    let mut queue = vec![first.to_string()];
    while let Some(t) = queue.pop() {
        if chain.contains(&t) || chain.len() > 8 {
            continue;
        }
        chain.push(t.clone());
        for d in dirs {
            if let Some(text) = read_string(env, &d.join(&t).join("index.theme")) {
                if let Some(inh) = ini_get(&text, "Icon Theme", "Inherits") {
                    queue.extend(inh.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).rev());
                }
                break;
            }
        }
    }
    for fallback in ["hicolor", "Adwaita"] {
        if !chain.iter().any(|c| c == fallback) {
            chain.push(fallback.to_string());
        }
    }
    chain
}

fn resolve_icon(env: &dyn DesktopEnv, dirs: &[PathBuf], chain: &[String], base: &str) -> Option<String> {
    let names = [format!("{base}-symbolic.svg"), format!("{base}.svg")];
    for theme in chain {
        for d in dirs {
            if let Some(path) = find_file(env, &d.join(theme), &names, 4) {
                let bytes = env.read(&path)?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                return Some(format!("data:image/svg+xml;base64,{b64}"));
            }
        }
    }
    None
}

fn resolve_icons(env: &dyn DesktopEnv, theme: &str) -> Option<ButtonIcons> {
    let dirs = icon_dirs(env);
    let chain = theme_chain(env, &dirs, theme);
    Some(ButtonIcons {
        close: resolve_icon(env, &dirs, &chain, "window-close")?,
        minimize: resolve_icon(env, &dirs, &chain, "window-minimize")?,
        maximize: resolve_icon(env, &dirs, &chain, "window-maximize")?,
        restore: resolve_icon(env, &dirs, &chain, "window-restore")?,
    })
}

// ---------- detecção ----------

enum Desktop {
    Kde,
    Pantheon,
    Other,
}

fn desktop(env: &dyn DesktopEnv) -> Desktop {
    let cur = env.var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_uppercase();
    let parts: Vec<&str> = cur.split(':').collect();
    if parts.contains(&"KDE") {
        Desktop::Kde
    } else if parts.contains(&"PANTHEON") {
        Desktop::Pantheon
    } else {
        Desktop::Other
    }
}

fn wm_layout(env: &dyn DesktopEnv, default: &str) -> ButtonLayout {
    let v = gsetting(env, "org.gnome.desktop.wm.preferences", "button-layout");
    parse_gnome(v.as_deref().unwrap_or(default))
}

pub fn detect_window_theme(env: &dyn DesktopEnv) -> WindowTheme {
    let cfg = config_home(env);
    let kdeglobals = read_string(env, &cfg.join("kdeglobals")).unwrap_or_default();
    let de = desktop(env);

    let (layout, style, gtk_theme) = match de {
        Desktop::Kde => {
            let kwinrc = read_string(env, &cfg.join("kwinrc")).unwrap_or_default();
            let get = |k: &str| ini_get(&kwinrc, "org.kde.kdecoration2", k);
            let layout = parse_kwin(
                &get("ButtonsOnLeft").unwrap_or_else(|| KDE_DEFAULT_LEFT.into()),
                &get("ButtonsOnRight").unwrap_or_else(|| KDE_DEFAULT_RIGHT.into()),
            );
            let style = match get("library").as_deref() {
                None | Some("org.kde.breeze") => DecorationStyle::Breeze,
                _ => DecorationStyle::Generic,
            };
            (layout, style, None)
        }
        Desktop::Pantheon => (wm_layout(env, "close:maximize"), DecorationStyle::Elementary, None),
        Desktop::Other => {
            let gtk = gsetting(env, "org.gnome.desktop.interface", "gtk-theme");
            let style = match gtk.as_deref() {
                None => DecorationStyle::Adwaita,
                Some(t) if t.starts_with("Adwaita") || t.starts_with("adw-gtk3") => DecorationStyle::Adwaita,
                Some(_) => DecorationStyle::Generic,
            };
            (wm_layout(env, GNOME_DEFAULT), style, gtk)
        }
    };

    let dark = match env.portal_color_scheme() {
        Some(1) => true,
        Some(2) => false,
        _ => match de {
            Desktop::Kde => ini_get(&kdeglobals, "Colors:Window", "BackgroundNormal")
                .and_then(|c| luminance_is_dark(&c))
                .unwrap_or(false),
            _ => {
                gsetting(env, "org.gnome.desktop.interface", "color-scheme").is_some_and(|v| v == "prefer-dark")
                    || gtk_theme.is_some_and(|t| t.ends_with("-dark") || t.ends_with("-Dark"))
            }
        },
    };

    let accent = env
        .portal_accent()
        .or_else(|| ini_get(&kdeglobals, "General", "AccentColor").and_then(|v| rgb_csv_to_hex(&v)));

    let icons = if style == DecorationStyle::Generic {
        let theme = match de {
            Desktop::Kde => ini_get(&kdeglobals, "Icons", "Theme"),
            _ => gsetting(env, "org.gnome.desktop.interface", "icon-theme"),
        };
        resolve_icons(env, theme.as_deref().unwrap_or("hicolor"))
    } else {
        None
    };

    let colors = if matches!(de, Desktop::Kde) { kde_colors(&kdeglobals) } else { None };

    WindowTheme { layout, style, dark, accent, icons, colors }
}

// ---------- sistema real ----------

pub struct SystemEnv;

impl DesktopEnv for SystemEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }

    fn list_dir(&self, path: &Path) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(path) else { return vec![] };
        let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        v.sort();
        v
    }

    fn gsettings(&self, schema: &str, key: &str) -> Option<String> {
        let out = std::process::Command::new("gsettings").args(["get", schema, key]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn portal_color_scheme(&self) -> Option<u32> {
        match super::watch::portal_read("color-scheme")? {
            zbus::zvariant::Value::U32(n) => Some(n),
            _ => None,
        }
    }

    fn portal_accent(&self) -> Option<String> {
        let zbus::zvariant::Value::Structure(s) = super::watch::portal_read("accent-color")? else {
            return None;
        };
        let f: Vec<f64> = s
            .fields()
            .iter()
            .filter_map(|v| if let zbus::zvariant::Value::F64(x) = v { Some(*x) } else { None })
            .collect();
        if f.len() != 3 || f.iter().any(|x| !(0.0..=1.0).contains(x)) {
            return None; // fora de [0,1] significa "sem cor de destaque"
        }
        let b = |x: f64| (x * 255.0).round() as u8;
        Some(format!("#{:02x}{:02x}{:02x}", b(f[0]), b(f[1]), b(f[2])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        vars: HashMap<&'static str, String>,
        files: HashMap<PathBuf, Vec<u8>>,
        gs: HashMap<(&'static str, &'static str), String>,
        scheme: Option<u32>,
        accent: Option<String>,
    }

    impl Fake {
        fn new(desktop: &str) -> Self {
            let mut f = Fake::default();
            f.vars.insert("XDG_CURRENT_DESKTOP", desktop.into());
            f.vars.insert("HOME", "/home/u".into());
            f
        }
        fn file(mut self, p: &str, c: &str) -> Self {
            self.files.insert(p.into(), c.as_bytes().to_vec());
            self
        }
        fn gs(mut self, schema: &'static str, key: &'static str, v: &str) -> Self {
            self.gs.insert((schema, key), v.into());
            self
        }
    }

    impl DesktopEnv for Fake {
        fn var(&self, k: &str) -> Option<String> {
            self.vars.get(k).cloned()
        }
        fn read(&self, p: &Path) -> Option<Vec<u8>> {
            self.files.get(p).cloned()
        }
        fn list_dir(&self, p: &Path) -> Vec<PathBuf> {
            let mut out: Vec<PathBuf> = self
                .files
                .keys()
                .filter_map(|f| {
                    let rest = f.strip_prefix(p).ok()?;
                    rest.components().next().map(|c| p.join(c))
                })
                .collect();
            out.sort();
            out.dedup();
            out
        }
        fn gsettings(&self, s: &str, k: &str) -> Option<String> {
            self.gs.iter().find(|((a, b), _)| *a == s && *b == k).map(|(_, v)| v.clone())
        }
        fn portal_color_scheme(&self) -> Option<u32> {
            self.scheme
        }
        fn portal_accent(&self) -> Option<String> {
            self.accent.clone()
        }
    }

    const WM: &str = "org.gnome.desktop.wm.preferences";
    const IFACE: &str = "org.gnome.desktop.interface";

    #[test]
    fn kde_breeze_com_padroes_e_botoes_a_direita() {
        let env = Fake::new("KDE").file(
            "/home/u/.config/kwinrc",
            "[org.kde.kdecoration2]\nlibrary=org.kde.breeze\ntheme=Breeze\n",
        );
        let t = detect_window_theme(&env);
        assert_eq!(t.style, DecorationStyle::Breeze);
        assert_eq!(
            t.layout,
            parse_kwin("MS", "IAX"),
            "padrão KDE: minimizar, maximizar, fechar à direita"
        );
        assert!(!t.dark);
        assert!(t.icons.is_none());
    }

    #[test]
    fn kde_le_botoes_explicitos_e_cores_do_wm() {
        let env = Fake::new("KDE")
            .file("/home/u/.config/kwinrc", "[org.kde.kdecoration2]\nButtonsOnLeft=XIA\nButtonsOnRight=\nlibrary=org.kde.breeze\n")
            .file(
                "/home/u/.config/kdeglobals",
                "[WM]\nactiveBackground=1,2,3\nactiveForeground=255,255,255\ninactiveBackground=10,20,30\ninactiveForeground=100,100,100\n[General]\nAccentColor=61,174,233\n",
            );
        let t = detect_window_theme(&env);
        assert_eq!(t.layout, parse_kwin("XIA", ""));
        assert_eq!(t.accent.as_deref(), Some("#3daee9"));
        let c = t.colors.unwrap();
        assert_eq!((c.active_bg.as_str(), c.inactive_fg.as_str()), ("#010203", "#646464"));
    }

    #[test]
    fn gnome_adwaita_claro_e_escuro() {
        let claro = Fake::new("GNOME").gs(IFACE, "gtk-theme", "'Adwaita'").gs(WM, "button-layout", "'appmenu:minimize,maximize,close'");
        let t = detect_window_theme(&claro);
        assert_eq!(t.style, DecorationStyle::Adwaita);
        assert!(!t.dark);
        assert_eq!(t.layout, parse_gnome(":minimize,maximize,close"));

        let escuro = Fake::new("GNOME").gs(IFACE, "gtk-theme", "'Adwaita-dark'");
        let t = detect_window_theme(&escuro);
        assert_eq!(t.style, DecorationStyle::Adwaita);
        assert!(t.dark);
    }

    #[test]
    fn pantheon_vira_elementary_com_fechar_a_esquerda() {
        let env = Fake::new("Pantheon");
        let t = detect_window_theme(&env);
        assert_eq!(t.style, DecorationStyle::Elementary);
        assert_eq!(t.layout, parse_gnome("close:maximize"));
    }

    #[test]
    fn aurorae_vira_generic_com_icones_do_tema() {
        let svg = |n: &str| format!("<svg id='{n}'/>");
        let mut env = Fake::new("KDE")
            .file(
                "/home/u/.config/kwinrc",
                "[org.kde.kdecoration2]\nlibrary=org.kde.kwin.aurorae\ntheme=__aurorae__svg__Foo\n",
            )
            .file("/home/u/.config/kdeglobals", "[Icons]\nTheme=Foo\n");
        env.vars.insert("XDG_DATA_HOME", "/data".into());
        for n in ["close", "minimize", "maximize"] {
            env = env.file(&format!("/data/icons/Foo/actions/16/window-{n}-symbolic.svg"), &svg(n));
        }
        // restaurar só existe no tema herdado via hicolor
        env = env.file("/usr/share/icons/hicolor/scalable/actions/window-restore-symbolic.svg", &svg("restore"));
        env.scheme = Some(1);

        let t = detect_window_theme(&env);
        assert_eq!(t.style, DecorationStyle::Generic);
        assert!(t.dark, "color-scheme 1 do portal => escuro");
        let i = t.icons.expect("ícones resolvidos");
        let dec = |u: &str| {
            let b = u.strip_prefix("data:image/svg+xml;base64,").unwrap();
            String::from_utf8(base64::engine::general_purpose::STANDARD.decode(b).unwrap()).unwrap()
        };
        assert_eq!(dec(&i.close), svg("close"));
        assert_eq!(dec(&i.restore), svg("restore"));
    }

    #[test]
    fn portal_claro_vence_o_esquema_do_kde() {
        let mut env = Fake::new("KDE").file("/home/u/.config/kdeglobals", "[Colors:Window]\nBackgroundNormal=20,20,20\n");
        assert!(detect_window_theme(&env).dark, "sem portal usa a luminância do kdeglobals");
        env.scheme = Some(2);
        assert!(!detect_window_theme(&env).dark);
    }

    #[test]
    fn xdg_config_home_e_respeitado() {
        let mut env = Fake::new("KDE").file("/tmp/cfg/kwinrc", "[org.kde.kdecoration2]\nButtonsOnRight=X\nButtonsOnLeft=I\n");
        env.vars.insert("XDG_CONFIG_HOME", "/tmp/cfg".into());
        assert_eq!(detect_window_theme(&env).layout, parse_kwin("I", "X"));
    }
}
