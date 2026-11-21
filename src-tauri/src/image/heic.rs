//! Decodificador HEIC (HEVC) opcional: a libde265 é carregada com `dlopen` na primeira
//! abertura de HEIC (ver `native/heic/de265_dl.cc`). Sem ela, o app funciona e HEIC
//! retorna `AppError::HeicDecoderMissing`. AVIF não depende disto (aom é ligado direto).
use std::{
    ffi::{CStr, CString, c_char, c_int},
    sync::OnceLock,
};

unsafe extern "C" {
    fn gvi_de265_load(soname: *const c_char) -> c_int;
    fn gvi_de265_plugin() -> *const libheif_sys::heif_decoder_plugin;
}

/// Troca a biblioteca procurada (usado pelo teste "libde265 ausente"). Lida só na
/// primeira abertura de HEIC do processo; aceita só um nome, nunca um caminho.
pub const SONAME_ENV: &str = "GVI_LIBDE265_SONAME";
const DEFAULT_SONAME: &CStr = c"libde265.so.0";

static AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Soname a carregar: o da env se for um nome de arquivo simples (sem `/`, sem NUL,
/// não vazio), para não abrir uma biblioteca arbitrária por caminho; senão o padrão.
pub(super) fn soname(env: Option<String>, default: &CStr) -> CString {
    env.filter(|s| !s.is_empty() && !s.contains('/'))
        .and_then(|s| CString::new(s).ok())
        .unwrap_or_else(|| default.to_owned())
}

/// Carrega a libde265 e registra o plugin uma vez por processo.
pub fn hevc_available() -> bool {
    *AVAILABLE.get_or_init(|| {
        let soname = soname(std::env::var(SONAME_ENV).ok(), DEFAULT_SONAME);
        // SAFETY: funções C sem pré-condições. O `heif_init` nunca é desfeito: um
        // `heif_deinit` que zere o contador desregistraria o plugin.
        unsafe {
            libheif_sys::heif_init(std::ptr::null_mut());
            gvi_de265_load(soname.as_ptr()) == 1
                && libheif_sys::heif_register_decoder_plugin(gvi_de265_plugin()).code == 0
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soname_da_env_so_aceita_nome_sem_caminho() {
        let s = |v: &str| soname(Some(v.to_string()), DEFAULT_SONAME);
        assert_eq!(s("libde265-teste.so.0").as_c_str(), c"libde265-teste.so.0");
        for ruim in ["/tmp/evil.so", "./evil.so", "../lib/evil.so", "a/b.so", "", "lib\0x.so"] {
            assert_eq!(s(ruim).as_c_str(), DEFAULT_SONAME, "{ruim:?}");
        }
        assert_eq!(soname(None, DEFAULT_SONAME).as_c_str(), DEFAULT_SONAME);
    }
}
