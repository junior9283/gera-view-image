//! Lote 10 (Marcação extra): fontes do sistema para o painel Fontes.
use super::blocking;
use crate::error::AppResult;
use resvg::usvg::fontdb;
use std::sync::OnceLock;

/// Mais que isso é lista corrompida ou hostil: o painel não precisa de mais.
const MAX_FAMILIES: usize = 5000;
/// Nome de família maior que isto não é nome.
const MAX_NAME: usize = 120;

/// Nomes sem repetição (ignorando caixa), sem vazios nem caracteres de controle, em ordem
/// alfabética. Os nomes vêm dos arquivos de fonte e não são confiáveis.
pub(crate) fn normalize<I: IntoIterator<Item = String>>(names: I) -> Vec<String> {
    let mut out: Vec<String> = names
        .into_iter()
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty() && n.chars().count() <= MAX_NAME && !n.chars().any(char::is_control))
        .collect();
    out.sort_by_cached_key(|n| (n.to_lowercase(), n.clone()));
    out.dedup_by(|a, b| a.to_lowercase() == b.to_lowercase());
    out.truncate(MAX_FAMILIES);
    out
}

fn families(db: &fontdb::Database) -> Vec<String> {
    normalize(db.faces().filter_map(|f| f.families.first().map(|(n, _)| n.clone())))
}

/// A leitura das fontes é pesada (varre os diretórios de fontes): faz uma vez só.
fn load() -> &'static Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        families(&db)
    })
}

/// Famílias instaladas, sem repetição e em ordem alfabética. Roda fora da thread principal
/// (o GTK) porque a primeira chamada varre as pastas de fontes.
#[tauri::command]
pub async fn system_fonts() -> AppResult<Vec<String>> {
    blocking(|| Ok(load().clone())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn ordena_sem_repetir_ignorando_caixa() {
        let r = normalize(v(&["Zilla", "arial", "Arial", "  Inter ", "Noto Sans", "inter"]));
        assert_eq!(r, v(&["Arial", "Inter", "Noto Sans", "Zilla"]));
    }

    #[test]
    fn descarta_nomes_vazios_longos_ou_com_controle() {
        let longo = "x".repeat(MAX_NAME + 1);
        let r = normalize(vec!["".into(), "  ".into(), longo, "A\nB".into(), "A\u{0}".into(), "Ok".into()]);
        assert_eq!(r, v(&["Ok"]));
    }

    #[test]
    fn limita_o_tamanho_da_lista() {
        let r = normalize((0..MAX_FAMILIES + 50).map(|i| format!("F{i:06}")));
        assert_eq!(r.len(), MAX_FAMILIES);
    }

    #[test]
    fn usa_a_primeira_familia_de_cada_face() {
        let mut db = fontdb::Database::new();
        assert!(families(&db).is_empty());
        db.load_system_fonts();
        let r = families(&db);
        assert!(r.windows(2).all(|w| w[0].to_lowercase() < w[1].to_lowercase()));
    }
}
