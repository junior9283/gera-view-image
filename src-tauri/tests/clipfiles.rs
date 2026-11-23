//! Ida e volta real pela área de transferência do GTK. Mexe na área de transferência da tela em uso:
//! por isso só roda a pedido, num X virtual isolado (`xvfb-run -a cargo test --test clipfiles -- --ignored`).
use gera_view_image_lib::commands::clipfiles::{Payload, native};
use gtk::{gdk, glib};
use std::{cell::RefCell, rc::Rc, time::Duration};

#[test]
#[ignore = "usa a área de transferência da tela: rode isolado com xvfb-run"]
fn arquivos_copiados_voltam_com_acentos() {
    gtk::init().expect("precisa de uma tela (xvfb-run)");
    let dir = std::env::temp_dir().join(format!("gvi-clipfiles-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("São João.png");
    std::fs::write(&path, b"x").unwrap();
    let uri = glib::filename_to_uri(&path, None).unwrap().to_string();

    let clip = native::clipboard();
    let payload = Payload { uris: vec![uri.clone()], paths: vec![path.clone()], png: Some(b"PNG!".to_vec()) };
    native::set(&clip, payload).unwrap();

    let main = glib::MainLoop::new(None, false);
    let got = Rc::new(RefCell::new(None));
    let (g, m) = (got.clone(), main.clone());
    native::request(&clip, move |files| {
        *g.borrow_mut() = Some(files);
        m.quit();
    });
    let m = main.clone();
    glib::timeout_add_local_once(Duration::from_secs(10), move || m.quit());
    main.run();

    let read = |t: &str| clip.wait_for_contents(&gdk::Atom::intern(t)).map(|s| s.data());
    let gnome = read("x-special/gnome-copied-files");
    let png = read("image/png");
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(got.borrow().as_deref(), Some(&[path.to_string_lossy().into_owned()][..]));
    assert_eq!(gnome.unwrap(), format!("copy\n{uri}").into_bytes());
    assert_eq!(png.unwrap(), b"PNG!");
}
