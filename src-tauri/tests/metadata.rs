//! Inspetor: metadados (EXIF, IPTC, GPS, perfil ICC) de arquivos conhecidos.
#[path = "make_fixtures.rs"]
mod make_fixtures;

use gera_view_image_lib::image::{
    decode::decode,
    metadata::{Metadata, parse_blocks, read_metadata},
};
use make_fixtures::ensure_fixtures;

fn meta(name: &str) -> Metadata {
    let path = ensure_fixtures().join(name);
    let decoded = decode(&path).unwrap();
    read_metadata(&path, &decoded).unwrap()
}

fn campo<'a>(v: &'a [(String, String)], nome: &str) -> Option<&'a str> {
    v.iter().find(|(k, _)| k == nome).map(|(_, v)| v.as_str())
}

#[test]
fn metadata_jpeg_exif() {
    let m = meta("meta_gps.jpg");
    assert!(campo(&m.exif, "Make").unwrap().contains("Gera"));
    assert!(campo(&m.exif, "Model").unwrap().contains("TestCam"));
    let gps = m.gps.expect("GPS");
    assert!((gps.lat - 48.858333).abs() < 1e-5, "lat {}", gps.lat);
    assert!((gps.lon - -122.419444).abs() < 1e-5, "lon {}", gps.lon);
    assert!((gps.alt.unwrap() - 15.5).abs() < 1e-6);
    assert_eq!((m.general.width, m.general.height), (32, 24));
    assert_eq!(m.general.color_model, "RGB");
    assert!(!m.general.has_alpha);
    assert_eq!(m.general.depth, 8);
    assert!(m.general.file_size > 0);
    assert!(m.general.modified.starts_with("20"));
}

#[test]
fn png_sem_exif_retorna_vazio() {
    let m = meta("alpha.png");
    assert!(m.exif.is_empty());
    assert!(m.iptc.is_empty());
    assert!(m.gps.is_none());
    assert!(m.keywords.is_empty());
    assert!(m.general.has_alpha);
    assert!(m.general.profile.is_none());
}

#[test]
fn perfil_icc_nome() {
    let m = meta("meta_srgb.jpg");
    assert_eq!(m.general.profile.as_deref(), Some("sRGB IEC61966-2.1"));
}

#[test]
fn iptc_do_app13_com_palavras_chave() {
    let m = meta("meta_iptc.jpg");
    assert_eq!(campo(&m.iptc, "Title"), Some("Praia"));
    assert_eq!(campo(&m.iptc, "Copyright"), Some("Gera"));
    assert_eq!(m.keywords, vec!["mar".to_string(), "sol".to_string()]);
}

#[test]
fn bytes_invalidos_nao_derrubam() {
    let m = parse_blocks(b"lixo", None);
    assert!(m.exif.is_empty() && m.iptc.is_empty() && m.gps.is_none());
}
