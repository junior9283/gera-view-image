/// Aplica contornos para bugs do WebKitGTK (tela branca/pisca com DMABUF).
/// Deve ser chamada antes de criar qualquer janela.
pub fn apply_webkit_workarounds(
    env: &dyn Fn(&str) -> Option<String>,
    set: &mut dyn FnMut(&str, &str),
) {
    const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if env("GVI_GPU_ACCEL").as_deref() != Some("1") && env(DMABUF).is_none() {
        set(DMABUF, "1");
    }
    if env("GVI_SAFE_RENDER").as_deref() == Some("1") {
        set("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
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

    #[test]
    fn define_dmabuf_quando_ausente() {
        assert_eq!(roda(&[]), vec![par("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]);
    }

    #[test]
    fn respeita_valor_existente() {
        assert!(roda(&[("WEBKIT_DISABLE_DMABUF_RENDERER", "0")]).is_empty());
    }

    #[test]
    fn gpu_accel_desliga_contorno() {
        assert!(roda(&[("GVI_GPU_ACCEL", "1")]).is_empty());
    }

    #[test]
    fn safe_render_desliga_compositing() {
        let r = roda(&[("GVI_SAFE_RENDER", "1")]);
        assert!(r.contains(&par("WEBKIT_DISABLE_DMABUF_RENDERER", "1")));
        assert!(r.contains(&par("WEBKIT_DISABLE_COMPOSITING_MODE", "1")));
    }
}
