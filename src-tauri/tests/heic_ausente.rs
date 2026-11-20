//! Sem libde265 no sistema: o app abre normalmente, HEIC dá `heic_decoder_missing` e AVIF
//! (aom, ligado direto) continua funcionando. Binário de teste próprio porque a libde265
//! é procurada uma vez por processo.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    error::AppError,
    image::{decode::decode, heic},
};

#[test]
fn heic_sem_libde265_pede_para_instalar_e_avif_continua() {
    // SAFETY: nenhum outro teste deste binário lê o ambiente; a env vale na primeira
    // abertura de HEIC do processo, logo abaixo.
    unsafe { std::env::set_var(heic::SONAME_ENV, "libde265-ausente-de-proposito.so.0") };
    let dir = make_fixtures::ensure_fixtures();
    let e = decode(&dir.join("img.heic")).unwrap_err();
    assert!(matches!(e, AppError::HeicDecoderMissing(_)), "{e:?}");
    assert_eq!(e.code(), "heic_decoder_missing");
    assert!(!heic::hevc_available());
    let avif = decode(&dir.join("img.avif")).unwrap();
    assert!(avif.frames[0].width() > 0);
}
