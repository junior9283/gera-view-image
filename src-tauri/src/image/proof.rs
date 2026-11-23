//! Prova de Cor com Perfil: mostra na tela como a imagem sairia em outro perfil (impressora CMYK,
//! cinza ou outro RGB), sem tocar nos pixels do documento.
//!
//! São dois transforms da `moxcms`: imagem → prova (perceptual, como uma impressão de foto) e
//! prova → tela (colorimétrico relativo: o branco do papel é o branco da tela). Perfis são arquivos
//! não confiáveis: mesmos tetos de `icc`, e só entra o que converte nos dois sentidos.
use super::icc;
use crate::error::{AppError, AppResult};
use moxcms::{
    ColorProfile as Icc, DataColorSpace, Layout, RenderingIntent, Transform8BitExecutor,
    TransformOptions,
};
use rayon::prelude::*;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
};

/// Perfil de prova em uso por um documento.
#[derive(Debug, Clone, PartialEq)]
pub struct Proof {
    /// Um de `icc::BUILTIN` ou o caminho do arquivo.
    pub id: String,
    pub name: String,
    icc: Arc<Vec<u8>>,
}

/// Perfil que serve de destino de prova: RGB, CMYK ou cinza.
fn parse(bytes: &[u8]) -> Option<Icc> {
    icc::parse(bytes).filter(|p| layout(p).is_some())
}

/// Disposição dos canais na `moxcms` (os quatro do CMYK vão como `Rgba`).
fn layout(p: &Icc) -> Option<Layout> {
    match p.color_space {
        DataColorSpace::Rgb | DataColorSpace::Cmyk => Some(Layout::Rgba),
        DataColorSpace::Gray => Some(Layout::Gray),
        _ => None,
    }
}

fn is_proof_profile(bytes: &[u8]) -> bool {
    parse(bytes).is_some()
}

/// Perfis oferecidos no menu: os embutidos e os instalados no sistema, inclusive CMYK e cinza.
pub fn profiles() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> =
        icc::BUILTIN.iter().map(|(id, name)| (id.to_string(), name.to_string())).collect();
    let system = icc::system_profiles_where(is_proof_profile);
    out.extend(system.into_iter().filter(|(_, n)| !icc::BUILTIN.iter().any(|(_, b)| b == n)));
    out
}

/// Carrega o perfil `id` (embutido, do sistema ou arquivo escolhido pelo usuário). Lê o disco.
pub fn load(id: &str) -> AppResult<Proof> {
    let (bytes, name) = match icc::BUILTIN.iter().find(|(b, _)| *b == id) {
        Some((_, name)) => (icc::profile_bytes(id)?, Some(name.to_string())),
        None => {
            let bytes = Arc::new(icc::read_chosen(Path::new(id), is_proof_profile)?);
            let name = icc::describe(&bytes);
            (bytes, name)
        }
    };
    let name = name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
        Path::new(id).file_stem().map_or_else(String::new, |s| s.to_string_lossy().into_owned())
    });
    let proof = Proof { id: id.into(), name, icc: bytes };
    // A prova precisa dos dois sentidos; perfis só de entrada (A2B) não têm o de ida.
    let srgb = icc::srgb_icc();
    match chain(srgb, &proof.icc, srgb) {
        Some(_) => Ok(proof),
        None => Err(AppError::Unsupported(format!("perfil sem conversão de saída: {}", proof.name))),
    }
}

/// Imagem → prova → tela.
#[derive(Clone)]
struct Chain {
    to_proof: Arc<Transform8BitExecutor>,
    to_screen: Arc<Transform8BitExecutor>,
    /// Canais do perfil de prova no buffer intermediário.
    channels: usize,
}

type Key = [u64; 3];

/// Cadeias em cache (cada uma guarda algumas LUTs): troca de perfil, de documento e de tela.
const MAX_CHAINS: usize = 8;

fn chain(doc: &[u8], proof: &[u8], screen: &[u8]) -> Option<Chain> {
    static CACHE: LazyLock<Mutex<HashMap<Key, Option<Chain>>>> = LazyLock::new(Default::default);
    let key = [doc, proof, screen].map(icc::digest);
    let lock = || CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = lock().get(&key) {
        return c.clone();
    }
    let built = icc::guard(|| {
        let (d, s) = icc::parse_rgb(doc).zip(icc::parse_rgb(screen))?;
        let p = parse(proof)?;
        let l = layout(&p)?;
        Some(Chain {
            to_proof: transform(&d, Layout::Rgba, &p, l, RenderingIntent::Perceptual)?,
            to_screen: transform(&p, l, &s, Layout::Rgba, RenderingIntent::RelativeColorimetric)?,
            channels: if matches!(l, Layout::Gray) { 1 } else { 4 },
        })
    })
    .flatten();
    let mut cache = lock();
    if cache.len() >= MAX_CHAINS {
        cache.clear();
    }
    cache.insert(key, built.clone());
    built
}

/// Transform com a intenção pedida; perfil sem a tabela dela usa a primeira que existir.
fn transform(
    src: &Icc,
    src_layout: Layout,
    dst: &Icc,
    dst_layout: Layout,
    first: RenderingIntent,
) -> Option<Arc<Transform8BitExecutor>> {
    use RenderingIntent::{Perceptual, RelativeColorimetric, Saturation};
    [first, Perceptual, RelativeColorimetric, Saturation].into_iter().find_map(|rendering_intent| {
        let options = TransformOptions { rendering_intent, ..Default::default() };
        src.create_transform_8bit(src_layout, dst, dst_layout, options).ok()
    })
}

/// Pixels por bloco das conversões em paralelo.
const CHUNK_PX: usize = 16 * 1024;

/// Leva RGBA8 do perfil da imagem (`None` = sRGB) para o da tela passando pelo de prova; o alfa
/// fica como está. `false` = não deu (o buffer fica intacto).
#[must_use]
pub fn to_display(px: &mut [u8], doc: Option<&[u8]>, proof: &Proof) -> bool {
    let srgb = icc::srgb_icc();
    let (doc, screen) = match icc::screen_icc() {
        Some(screen) => (doc.unwrap_or(srgb), screen),
        // Correspondência de cor desligada: a imagem e a tela valem como sRGB.
        None => (srgb, Arc::new(srgb.to_vec())),
    };
    let Some(c) = chain(doc, &proof.icc, &screen) else {
        return false;
    };
    let out: Option<Vec<Vec<u8>>> = px.par_chunks(CHUNK_PX * 4).map(|b| run(b, &c)).collect();
    let Some(out) = out else { return false };
    px.par_chunks_mut(CHUNK_PX * 4).zip(out).for_each(|(dst, src)| {
        for (d, s) in dst.as_chunks_mut::<4>().0.iter_mut().zip(src.as_chunks::<4>().0) {
            d[..3].copy_from_slice(&s[..3]);
        }
    });
    true
}

fn run(block: &[u8], c: &Chain) -> Option<Vec<u8>> {
    icc::guard(|| {
        let mut mid = vec![0u8; block.len() / 4 * c.channels];
        c.to_proof.transform(block, &mut mid).ok()?;
        let mut out = vec![0u8; block.len()];
        c.to_screen.transform(&mid, &mut out).ok()?;
        Some(out)
    })
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::test_util::{TempDir, cmyk_profile};

    fn file(dir: &TempDir, name: &str, bytes: &[u8]) -> String {
        let p = dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_str().unwrap().to_string()
    }

    /// O perfil de teste só tem tinta preta: tudo vira cinza da mesma luminosidade.
    #[test]
    fn cmyk_de_saida_muda_a_tela_e_preserva_o_alfa() {
        let dir = TempDir::new("prova-cmyk");
        let p = load(&file(&dir, "Papel Jornal.icc", &cmyk_profile("Papel não revestido"))).unwrap();
        assert_eq!(p.name, "Papel não revestido");
        let mut px = vec![255, 0, 0, 7, 255, 255, 255, 255, 0, 0, 0, 128];
        assert!(to_display(&mut px, None, &p));
        assert!(px[0].abs_diff(px[1]) <= 3 && px[1].abs_diff(px[2]) <= 3, "{px:?}");
        assert!((100..=150).contains(&px[0]), "L do vermelho: {px:?}");
        assert_eq!((px[3], px[7], px[11]), (7, 255, 128));
        assert!(px[4..7].iter().all(|&v| v >= 250), "papel branco: {px:?}");
        assert!(px[8..11].iter().all(|&v| v <= 8), "preto: {px:?}");
    }

    #[test]
    fn prova_rgb_so_corta_o_que_nao_cabe() {
        let p3 = load("display-p3").unwrap();
        let mut px = vec![200, 100, 50, 255, 255, 0, 0, 255];
        assert!(to_display(&mut px, None, &p3));
        for (a, b) in px.iter().zip([200, 100, 50, 255, 255, 0, 0, 255]) {
            assert!(a.abs_diff(b) <= 2, "sRGB cabe no P3: {px:?}");
        }
        // Verde do P3 provado em sRGB perde saturação.
        let srgb = load("srgb").unwrap();
        let p3 = icc::profile_bytes("display-p3").unwrap();
        let mut px = vec![0, 255, 0, 255];
        assert!(to_display(&mut px, Some(&p3), &srgb));
        assert_eq!(px, [0, 255, 0, 255]);
    }

    #[test]
    fn blocos_cobrem_o_buffer_inteiro() {
        let dir = TempDir::new("prova-blocos");
        let p = load(&file(&dir, "a.icc", &cmyk_profile("K"))).unwrap();
        let mut px = [255u8, 0, 0, 9].repeat(CHUNK_PX * 2 + 3);
        assert!(to_display(&mut px, None, &p));
        assert!(px.as_chunks::<4>().0.iter().all(|c| c[0].abs_diff(c[1]) <= 3 && c[3] == 9));
    }

    #[test]
    fn perfil_ruim_e_recusado() {
        let dir = TempDir::new("prova-ruim");
        let bom = cmyk_profile("K");
        let sem_ida = {
            // Só A2B0 (perfil de entrada): não há como ir para a prova.
            let mut b = bom.clone();
            let at = b.windows(4).position(|w| w == b"B2A0").unwrap();
            b[at..at + 4].copy_from_slice(b"zzzz");
            b
        };
        for (nome, bytes) in [
            ("lixo.icc", b"nada".to_vec()),
            ("vazio.icc", vec![]),
            ("truncado.icc", bom[..bom.len() / 2].to_vec()),
            ("entrada.icc", sem_ida),
            ("perfil.txt", bom.clone()),
        ] {
            assert!(load(&file(&dir, nome, &bytes)).is_err(), "{nome}");
        }
        let grande = dir.path().join("grande.icc");
        std::fs::File::create(&grande).unwrap().set_len(17 << 20).unwrap();
        for p in [grande.to_str().unwrap(), "relativo.icc", "/dev/zero", "/etc/passwd", "/nao/existe.icc", ""] {
            assert!(load(p).is_err(), "{p}");
        }
    }

    /// Perfis adulterados nunca derrubam o app nem mexem no alfa.
    #[test]
    fn adulterado_nao_panica() {
        let good = cmyk_profile("K");
        for i in 0..good.len().min(700) {
            for v in [0x00, 0xFF] {
                let mut b = good.clone();
                b[i] = v;
                let p = Proof { id: String::new(), name: String::new(), icc: Arc::new(b) };
                let mut px = [200u8, 100, 50, 77];
                let _ = to_display(&mut px, None, &p);
                assert_eq!(px[3], 77, "byte {i}");
            }
        }
    }
}
