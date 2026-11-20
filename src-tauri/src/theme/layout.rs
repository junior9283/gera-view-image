//! Lado e ordem dos botões da janela, lidos do KDE (letras) ou do GNOME (`button-layout`).
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WinButton {
    Minimize,
    Maximize,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ButtonLayout {
    pub left: Vec<WinButton>,
    pub right: Vec<WinButton>,
}

/// Padrões quando a chave está ausente.
pub const KDE_DEFAULT_LEFT: &str = "MS";
pub const KDE_DEFAULT_RIGHT: &str = "HIAX";
pub const GNOME_DEFAULT: &str = "appmenu:close";

fn push_unique(v: &mut Vec<WinButton>, b: WinButton) {
    if !v.contains(&b) {
        v.push(b);
    }
}

fn parse_kwin_side(s: &str) -> Vec<WinButton> {
    let mut out = Vec::new();
    for c in s.chars() {
        match c {
            'I' => push_unique(&mut out, WinButton::Minimize),
            'A' => push_unique(&mut out, WinButton::Maximize),
            'X' => push_unique(&mut out, WinButton::Close),
            _ => {} // M (menu), S (todos os desktops), H (ajuda) etc. não são desenhados
        }
    }
    out
}

fn parse_gnome_side(s: &str) -> Vec<WinButton> {
    let mut out = Vec::new();
    for t in s.split(',') {
        match t.trim() {
            "minimize" => push_unique(&mut out, WinButton::Minimize),
            "maximize" => push_unique(&mut out, WinButton::Maximize),
            "close" => push_unique(&mut out, WinButton::Close),
            _ => {} // appmenu, icon, spacer
        }
    }
    out
}

/// `ButtonsOnLeft` / `ButtonsOnRight` do `kwinrc` (`I`=minimizar, `A`=maximizar, `X`=fechar).
pub fn parse_kwin(left: &str, right: &str) -> ButtonLayout {
    ButtonLayout { left: parse_kwin_side(left), right: parse_kwin_side(right) }
}

/// `button-layout` do GNOME (`esquerda:direita`; sem `:`, tudo fica à esquerda).
pub fn parse_gnome(layout: &str) -> ButtonLayout {
    match layout.split_once(':') {
        Some((l, r)) => ButtonLayout { left: parse_gnome_side(l), right: parse_gnome_side(r) },
        None => ButtonLayout { left: parse_gnome_side(layout), right: vec![] },
    }
}

#[cfg(test)]
mod tests {
    use super::WinButton::*;
    use super::*;

    #[test]
    fn kwin_ordem_e_lado() {
        assert_eq!(parse_kwin("MS", "IAX"), ButtonLayout { left: vec![], right: vec![Minimize, Maximize, Close] });
        assert_eq!(parse_kwin("XIA", "M"), ButtonLayout { left: vec![Close, Minimize, Maximize], right: vec![] });
    }

    #[test]
    fn kwin_padrao_ignora_ajuda_e_menu() {
        assert_eq!(
            parse_kwin(KDE_DEFAULT_LEFT, KDE_DEFAULT_RIGHT),
            ButtonLayout { left: vec![], right: vec![Minimize, Maximize, Close] }
        );
    }

    #[test]
    fn gnome_lados() {
        assert_eq!(parse_gnome("icon:minimize,maximize,close"), ButtonLayout { left: vec![], right: vec![Minimize, Maximize, Close] });
        assert_eq!(parse_gnome("close,minimize,maximize:"), ButtonLayout { left: vec![Close, Minimize, Maximize], right: vec![] });
        assert_eq!(parse_gnome(":close"), ButtonLayout { left: vec![], right: vec![Close] });
        assert_eq!(parse_gnome(GNOME_DEFAULT), ButtonLayout { left: vec![], right: vec![Close] });
    }

    #[test]
    fn gnome_ignora_desconhecidos_e_repetidos() {
        assert_eq!(parse_gnome("appmenu:minimize,spacer,close,close"), ButtonLayout { left: vec![], right: vec![Minimize, Close] });
    }
}
