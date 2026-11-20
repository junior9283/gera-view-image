//! A flag `--version` responde sem abrir janela.
#[test]
fn version_imprime_nome_e_versao() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_gera-view-image"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        format!("gera-view-image {}", env!("CARGO_PKG_VERSION"))
    );
}
