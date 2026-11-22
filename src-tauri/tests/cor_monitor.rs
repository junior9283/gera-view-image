//! Cor com perfil de monitor (X11) e com a correspondência desligada. Binário próprio e um teste
//! só: o perfil de exibição é global do processo.
use gera_view_image_lib::{
    commands::paste::{copied_region, layer_png},
    doc::{
        file::render_png,
        model::{DocId, Op, SourceFormat},
        store::DocStore,
    },
    image::{decode::Decoded, icc},
};
use image::{Rgba, RgbaImage};

const PX: [u8; 4] = [200, 100, 50, 255];

fn store_with(profile: Option<&str>) -> (DocStore, DocId) {
    let store = DocStore::new();
    let decoded = Decoded {
        icc: profile.map(|id| icc::profile_bytes(id).unwrap().to_vec()),
        ..Decoded::single(RgbaImage::from_pixel(4, 3, Rgba(PX)), SourceFormat::Png)
    };
    let id = store.insert_decoded("", decoded).id;
    (store, id)
}

fn view(store: &DocStore, id: DocId) -> Vec<u8> {
    store.render_view(id, 0, 4, 3, None).unwrap()[8..12].to_vec()
}

#[track_caller]
fn near(got: &[u8], want: &[u8]) {
    assert!(
        got[..3].iter().zip(want).all(|(a, b)| a.abs_diff(*b) <= 2),
        "obtido {got:?}, esperado {want:?}"
    );
}

/// Copia o documento, cola por cima e achata: nem o que se vê nem o documento mudam.
fn copia_cola_achata(profile: Option<&str>) -> RgbaImage {
    let (store, id) = store_with(profile);
    let seen = view(&store, id);
    let copied = copied_region(&store, id, 0, None, None).unwrap();
    let png = layer_png(copied.clone()).unwrap();
    store.apply_op(id, Op::Composite { png, frame: None }).unwrap();
    near(&view(&store, id), &seen);
    near(&store.render_full(id, 0).unwrap().get_pixel(1, 1).0, &PX);
    copied
}

#[test]
fn area_de_transferencia_com_monitor_e_com_a_correspondencia_desligada() {
    // Monitor Adobe RGB: a área de transferência continua sRGB.
    let monitor = icc::profile_bytes("adobe-rgb").unwrap().to_vec();
    assert!(icc::configure(true, Some(monitor)));
    let (store, id) = store_with(None);
    assert_ne!(view(&store, id), PX, "a tela recebe o perfil do monitor");
    assert_eq!(copia_cola_achata(None).get_pixel(1, 1).0, PX);
    near(&copia_cola_achata(Some("display-p3")).get_pixel(1, 1).0, &[215, 93, 31]);
    // O PNG do arraste e da impressão também é sRGB.
    let (store, id) = store_with(Some("display-p3"));
    let png = image::load_from_memory(&render_png(&store, id).unwrap()).unwrap();
    near(&png.to_rgba8().get_pixel(0, 0).0, &[215, 93, 31]);

    // Desligada: a tela mostra os números crus, e Copiar/Colar também.
    assert!(icc::configure(false, None));
    assert_eq!(copia_cola_achata(Some("display-p3")).get_pixel(1, 1).0, PX);
}
