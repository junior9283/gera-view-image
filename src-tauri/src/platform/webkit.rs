use tauri::utils::config::WindowConfig;

/// Ajusta o ambiente para o WebKitGTK. Deve ser chamada antes de criar qualquer janela.
///
/// Por padrão **não** desliga o DMABUF nem o compositing: com a janela transparente, qualquer um
/// dos dois desligados deixa na tela só a última região redesenhada (WebKitGTK 2.54, Wayland; ver
/// `docs/testes/bugs.md`). Só define `__NV_DISABLE_EXPLICIT_SYNC=1`: sem isso o driver da Nvidia
/// derruba o app com "Error 71 dispatching to Wayland display"; as outras placas o ignoram.
/// `GVI_SAFE_RENDER=1` volta ao desenho por software, para máquinas onde a GPU falha (exige a
/// janela opaca, ver [`apply_safe_window`]).
/// Valores já presentes no ambiente são respeitados.
pub fn apply_webkit_workarounds(
    env: &dyn Fn(&str) -> Option<String>,
    set: &mut dyn FnMut(&str, &str),
) {
    let mut default_on = |var: &str| {
        if env(var).is_none() {
            set(var, "1");
        }
    };
    default_on("__NV_DISABLE_EXPLICIT_SYNC");
    if safe_render(env) {
        default_on("WEBKIT_DISABLE_DMABUF_RENDERER");
        default_on("WEBKIT_DISABLE_COMPOSITING_MODE");
    }
}

fn safe_render(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env("GVI_SAFE_RENDER").as_deref() == Some("1")
}

/// No modo de segurança a janela precisa ser opaca: transparente e sem GPU, ela some.
pub fn apply_safe_window(env: &dyn Fn(&str) -> Option<String>, windows: &mut [WindowConfig]) {
    if safe_render(env) {
        for window in windows {
            window.transparent = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn roda(vars: &[(&str, &str)]) -> Vec<(String, String)> {
        let mapa: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let mut definidos = Vec::new();
        apply_webkit_workarounds(&|k| mapa.get(k).cloned(), &mut |k, v| {
            definidos.push((k.to_string(), v.to_string()))
        });
        definidos
    }

    fn par(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    const COMPOSITING: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

    const NV_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";

    #[test]
    fn padrao_mantem_o_desenho_acelerado_e_so_desliga_o_explicit_sync() {
        assert_eq!(roda(&[]), vec![par(NV_SYNC, "1")]);
    }

    #[test]
    fn modo_de_seguranca_desliga_dmabuf_e_compositing() {
        let r = roda(&[("GVI_SAFE_RENDER", "1")]);
        assert_eq!(
            r,
            vec![par(NV_SYNC, "1"), par(DMABUF, "1"), par(COMPOSITING, "1")]
        );
    }

    #[test]
    fn respeita_valores_existentes() {
        let r = roda(&[
            ("GVI_SAFE_RENDER", "1"),
            (DMABUF, "0"),
            (COMPOSITING, "0"),
            (NV_SYNC, "0"),
        ]);
        assert!(r.is_empty(), "{r:?}");
    }

    #[test]
    fn modo_de_seguranca_abre_janela_opaca() {
        let transparente = || {
            vec![WindowConfig {
                transparent: true,
                ..Default::default()
            }]
        };
        let mut normal = transparente();
        apply_safe_window(&|_| None, &mut normal);
        assert!(normal[0].transparent);

        let mut seguro = transparente();
        apply_safe_window(
            &|k| (k == "GVI_SAFE_RENDER").then(|| "1".to_string()),
            &mut seguro,
        );
        assert!(!seguro[0].transparent);
    }
}
