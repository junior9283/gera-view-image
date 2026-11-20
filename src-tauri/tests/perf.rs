//! Medição manual (build release): `GVI_PERF_JPEG=/caminho/24mp.jpg cargo test --release --test perf -- --ignored --nocapture`.
use gera_view_image_lib::{doc::store::DocStore, image::decode};
use std::time::Instant;

#[test]
#[ignore = "medição manual; precisa de GVI_PERF_JPEG"]
fn abertura_jpeg_grande() {
    let path = std::env::var("GVI_PERF_JPEG").expect("defina GVI_PERF_JPEG");
    for rodada in 1..=3 {
        let store = DocStore::new();
        let t = Instant::now();
        let info = store.open_documents(std::slice::from_ref(&path)).remove(0);
        let aberto = t.elapsed();
        let buf = store.render_view(info.id, 0, 1600, 1200, None).unwrap();
        let primeira = t.elapsed();
        store.wait_ready(info.id).unwrap();
        let completo = t.elapsed();
        let buf2 = store.render_view(info.id, 0, 1600, 1200, None).unwrap();
        let segunda = t.elapsed();
        assert_eq!(buf.len(), buf2.len());
        eprintln!(
            "rodada {rodada}: {}x{} aberto(prévia) {:?} | 1º render_view {:?} | decode completo {:?} | render cheio {:?}",
            info.width, info.height, aberto, primeira, completo, segunda
        );
    }
    let t = Instant::now();
    decode::decode(std::path::Path::new(&path)).unwrap();
    eprintln!("decode completo isolado (crate image): {:?}", t.elapsed());
}
