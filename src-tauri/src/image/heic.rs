//! Decodificador HEIC (HEVC) opcional: a libde265 é carregada com `dlopen` na primeira
//! abertura de HEIC (ver `native/heic/de265_dl.cc`). Sem ela, o app funciona e HEIC
//! retorna `AppError::HeicDecoderMissing`. AVIF não depende disto (aom é ligado direto).
use std::{
    ffi::{CStr, c_char, c_int},
    sync::{Mutex, OnceLock},
};

unsafe extern "C" {
    fn gvi_de265_load(soname: *const c_char) -> c_int;
    fn gvi_de265_plugin() -> *const libheif_sys::heif_decoder_plugin;
}

static SONAME: Mutex<&'static CStr> = Mutex::new(c"libde265.so.0");
static AVAILABLE: OnceLock<bool> = OnceLock::new();

/// SÓ PARA TESTES (caso "libde265 ausente"): troca a biblioteca procurada.
/// Só vale se chamada antes da primeira abertura de HEIC no processo. Fica pública
/// (oculta da doc) porque os testes de integração não enxergam `cfg(test)` da lib.
#[doc(hidden)]
pub fn set_libde265_soname(soname: &'static CStr) {
    *SONAME.lock().unwrap_or_else(|e| e.into_inner()) = soname;
}

/// Carrega a libde265 e registra o plugin uma vez por processo.
pub fn hevc_available() -> bool {
    *AVAILABLE.get_or_init(|| {
        let soname = *SONAME.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: funções C sem pré-condições. O `heif_init` nunca é desfeito: um
        // `heif_deinit` que zere o contador desregistraria o plugin.
        unsafe {
            libheif_sys::heif_init(std::ptr::null_mut());
            gvi_de265_load(soname.as_ptr()) == 1
                && libheif_sys::heif_register_decoder_plugin(gvi_de265_plugin()).code == 0
        }
    })
}
