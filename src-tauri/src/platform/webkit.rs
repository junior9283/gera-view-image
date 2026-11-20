/// Aplica contornos para bugs do WebKitGTK. Deve ser chamada antes de criar qualquer janela.
///
/// Por padrão define `WEBKIT_DISABLE_DMABUF_RENDERER=1` (tela branca/pisca com DMABUF) e
/// `WEBKIT_DISABLE_COMPOSITING_MODE=1` (janela transparente e sem decoração fica toda branca
/// em sessões Wayland, redesenhando só a região sob o mouse). Valores já presentes no
/// ambiente são respeitados; `GVI_GPU_ACCEL=1` desliga os dois contornos.
/// `GVI_SAFE_RENDER=1` ainda é aceito, mas é redundante: o modo seguro já é o padrão.
pub fn apply_webkit_workarounds(
    env: &dyn Fn(&str) -> Option<String>,
    set: &mut dyn FnMut(&str, &str),
) {
    if env("GVI_GPU_ACCEL").as_deref() == Some("1") {
        return;
    }
    for var in [
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        if env(var).is_none() {
            set(var, "1");
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

    #[test]
    fn define_dmabuf_quando_ausente() {
        assert!(roda(&[]).contains(&par(DMABUF, "1")));
    }

    #[test]
    fn define_compositing_por_padrao() {
        assert!(roda(&[]).contains(&par(COMPOSITING, "1")));
    }

    #[test]
    fn respeita_valor_existente() {
        assert!(!roda(&[(DMABUF, "0")]).iter().any(|(k, _)| k == DMABUF));
    }

    #[test]
    fn respeita_compositing_existente() {
        let r = roda(&[(COMPOSITING, "0")]);
        assert!(!r.iter().any(|(k, _)| k == COMPOSITING));
        assert!(r.contains(&par(DMABUF, "1")));
    }

    #[test]
    fn gpu_accel_desliga_ambos() {
        assert!(roda(&[("GVI_GPU_ACCEL", "1")]).is_empty());
    }

    #[test]
    fn safe_render_e_redundante() {
        assert_eq!(roda(&[("GVI_SAFE_RENDER", "1")]), roda(&[]));
    }
}
