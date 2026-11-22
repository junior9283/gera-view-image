//! Sem libkvazaar no sistema: gravar HEIC fica indisponível sem crash. O codificador recusa
//! com `unsupported` e o HEIC aberto não é regravável (Salvar leva a Exportar). Binário de
//! teste próprio porque a libkvazaar é procurada uma vez por processo.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::{
    doc::{file::SaveOutcome, store::DocStore},
    image::{
        encode::{ExportFormat, ExportOptions, MetaCarry, encode},
        encode_heic, heic,
    },
};
use image::RgbaImage;

#[test]
fn heic_sem_libkvazaar_nao_grava_e_salvar_leva_a_exportar() {
    // SAFETY: nenhum outro teste deste binário lê o ambiente; a env vale na primeira
    // consulta do processo, logo abaixo.
    unsafe {
        std::env::set_var(
            encode_heic::SONAME_ENV,
            "libkvazaar-ausente-de-proposito.so.7",
        )
    };
    assert!(!encode_heic::hevc_encoder_available());
    let opts = ExportOptions {
        format: ExportFormat::Heic,
        quality: None,
        alpha: true,
        depth16: false,
        strip_metadata: false,
        resize: None,
        color_profile: None,
    };
    let e = encode(&RgbaImage::new(8, 8), &opts, &MetaCarry::default()).unwrap_err();
    assert_eq!(e.code(), "unsupported");

    if !heic::hevc_available() {
        return; // sem libde265 o HEIC nem abre
    }
    let src = make_fixtures::ensure_fixtures().join("img.heic");
    let path = make_fixtures::tmp("kvazaar-ausente").join("img.heic");
    std::fs::copy(&src, &path).unwrap();
    let store = DocStore::new();
    let info = store
        .open_documents(&[path.to_string_lossy().into_owned()])
        .remove(0);
    assert_eq!(info.error, None);
    store.wait_ready(info.id).unwrap();
    assert!(!store.info(info.id).unwrap().writable);
    assert!(matches!(
        store.save(info.id, None).unwrap(),
        SaveOutcome::NeedsExport
    ));
}
