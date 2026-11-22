//! Perfil de cor do documento (Lote 1): o atribuído pelo usuário ou o embutido no arquivo.
use super::{
    model::{DocId, Op},
    store::{DocStore, Document},
};
use crate::image::{decode::Decoded, icc};
use std::sync::Arc;

/// Perfil ICC que descreve os pixels do documento.
#[derive(Clone)]
pub enum Profile {
    /// O que veio no arquivo (`Decoded::icc`), sem copiar os bytes.
    Embedded(Arc<Decoded>),
    /// O de Atribuir Perfil….
    Assigned(Arc<Vec<u8>>),
}

impl Profile {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Profile::Embedded(d) => d.icc.as_deref().unwrap_or_default(),
            Profile::Assigned(b) => b,
        }
    }
}

impl Document {
    /// Último Atribuir Perfil… válido, senão o perfil embutido; `None` = sRGB presumido.
    pub fn profile(&self) -> Option<Profile> {
        let assigned = self.ops.iter().rev().find_map(|op| match op {
            Op::AssignProfile { profile } => icc::known_profile(profile),
            _ => None,
        });
        match assigned {
            Some(b) => Some(Profile::Assigned(b)),
            None if self.source.icc.is_some() => Some(Profile::Embedded(self.source.clone())),
            None => None,
        }
    }

    /// `(id, nome)` do perfil de [`Document::profile`]; `id` vazio quando é o embutido.
    pub fn profile_name(&self) -> Option<(String, String)> {
        let id = self.ops.iter().rev().find_map(|op| match op {
            Op::AssignProfile { profile } => Some(profile.as_str()),
            _ => None,
        });
        let builtin = icc::BUILTIN.iter().find(|(b, _)| Some(*b) == id);
        let name = match builtin {
            Some((_, name)) => name.to_string(),
            None => icc::describe(self.profile()?.bytes())?,
        };
        Some((id.unwrap_or_default().to_string(), name))
    }
}

impl DocStore {
    /// Converte o RGBA de uma prévia do documento `id` para o perfil de exibição.
    pub fn to_display(&self, id: DocId, rgba: &mut [u8]) {
        let p = self.with_doc(id, Document::profile).ok().flatten();
        icc::to_display(rgba, p.as_ref().map(Profile::bytes));
    }

    /// PNG das anotações (desenhado pela interface sobre a prévia, em cores de tela) levado ao
    /// espaço do documento `id`, para compor sobre os pixels dele.
    pub fn png_from_display(&self, id: DocId, png: Vec<u8>) -> Vec<u8> {
        let p = self.with_doc(id, Document::profile).ok().flatten();
        icc::png_from_display(&png, p.as_ref().map(Profile::bytes)).unwrap_or(png)
    }

    /// O perfil de exibição mudou: avança `rev` de todos os documentos para refazer as prévias.
    pub fn redisplay_all(&self) {
        let infos: Vec<_> = self
            .lock()
            .values_mut()
            .map(|d| {
                d.refresh();
                d.info.clone()
            })
            .collect();
        for info in &infos {
            self.notify(info);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::model::SourceFormat;
    use ::image::{Rgba, RgbaImage};

    fn store_with(icc: Option<Vec<u8>>) -> (DocStore, DocId) {
        let store = DocStore::new();
        let img = RgbaImage::from_pixel(4, 3, Rgba([200, 100, 50, 255]));
        let decoded = Decoded {
            icc,
            ..Decoded::single(img, SourceFormat::Png)
        };
        let id = store.insert_decoded("", decoded).id;
        (store, id)
    }

    fn view_px(store: &DocStore, id: DocId) -> [u8; 4] {
        let buf = store.render_view(id, 0, 64, 64, None).unwrap();
        buf[8..12].try_into().unwrap()
    }

    fn icc_of(store: &DocStore, id: DocId) -> Option<Vec<u8>> {
        store
            .with_doc(id, |d| d.profile().map(|p| p.bytes().to_vec()))
            .unwrap()
    }

    fn thumb_px(store: &DocStore, id: DocId) -> [u8; 4] {
        let buf = store.thumbnail(id, 0, 16).unwrap();
        buf[8..12].try_into().unwrap()
    }

    #[track_caller]
    fn near(got: [u8; 4], want: [u8; 3]) {
        let ok = got[..3].iter().zip(want).all(|(g, w)| g.abs_diff(w) <= 2);
        assert!(ok && got[3] == 255, "obtido {got:?}, esperado {want:?}");
    }

    #[test]
    fn previa_e_miniatura_convertem_o_perfil_embutido() {
        let p3 = icc::profile_bytes("display-p3").unwrap().to_vec();
        let (store, id) = store_with(Some(p3));
        near(view_px(&store, id), [215, 93, 31]);
        near(thumb_px(&store, id), [215, 93, 31]);
        // O documento continua no espaço do arquivo.
        assert_eq!(store.render_full(id, 0).unwrap().get_pixel(0, 0).0, [200, 100, 50, 255]);
    }

    #[test]
    fn sem_perfil_nada_muda() {
        let (store, id) = store_with(None);
        assert_eq!(view_px(&store, id), [200, 100, 50, 255]);
    }

    #[test]
    fn atribuir_perfil_reinterpreta_e_desfaz() {
        let (store, id) = store_with(None);
        let op = Op::AssignProfile {
            profile: "adobe-rgb".into(),
        };
        let info = store.apply_op(id, op).unwrap();
        assert!(info.dirty && info.can_undo);
        near(view_px(&store, id), [227, 100, 42]);
        assert_eq!(store.render_full(id, 0).unwrap().get_pixel(0, 0).0, [200, 100, 50, 255]);
        assert_eq!(
            icc_of(&store, id).as_deref(),
            Some(icc::profile_bytes("adobe-rgb").unwrap().as_slice())
        );
        store.undo(id).unwrap();
        assert_eq!(view_px(&store, id), [200, 100, 50, 255]);
        assert_eq!(icc_of(&store, id), None);
    }

    #[test]
    fn atribuir_perfil_depois_de_outras_operacoes() {
        let (store, id) = store_with(None);
        store.apply_op(id, Op::FlipH).unwrap();
        store
            .apply_op(id, Op::AssignProfile { profile: "display-p3".into() })
            .unwrap();
        near(view_px(&store, id), [215, 93, 31]);
        let runs = store.pipeline_runs();
        store.render_full(id, 0).unwrap();
        assert_eq!(store.pipeline_runs(), runs, "Atribuir Perfil não refaz a cadeia");
    }

    fn solid_png(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        RgbaImage::from_pixel(w, h, Rgba(px))
            .write_to(&mut out, ::image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn p3() -> Vec<u8> {
        icc::profile_bytes("display-p3").unwrap().to_vec()
    }

    /// A Lupa lê a prévia (cores de tela) e o achatamento a compõe no documento P3: o que se vê
    /// e os pixels do documento não mudam.
    #[test]
    fn lupa_achatada_nao_converte_duas_vezes() {
        let (store, id) = store_with(Some(p3()));
        let seen = view_px(&store, id);
        let png = solid_png(4, 3, seen);
        store.apply_op(id, Op::Composite { png }).unwrap();
        near(view_px(&store, id), [seen[0], seen[1], seen[2]]);
        near(store.render_full(id, 0).unwrap().get_pixel(0, 0).0, [200, 100, 50]);
    }

    /// Uma anotação vermelha (sRGB na tela) continua vermelha na tela depois de achatada, e no
    /// documento P3 vale o vermelho sRGB em P3.
    #[test]
    fn anotacao_achatada_mantem_a_cor_da_tela() {
        let (store, id) = store_with(Some(p3()));
        let png = solid_png(4, 3, [255, 0, 0, 255]);
        store.apply_op(id, Op::Composite { png }).unwrap();
        near(view_px(&store, id), [255, 0, 0]);
        near(store.render_full(id, 0).unwrap().get_pixel(0, 0).0, [234, 51, 35]);
        // Sem perfil, o PNG entra como está.
        let (store, id) = store_with(None);
        let png = solid_png(4, 3, [255, 0, 0, 255]);
        store.apply_op(id, Op::Composite { png }).unwrap();
        assert_eq!(view_px(&store, id), [255, 0, 0, 255]);
    }

    /// O mesmo ao Salvar em 16 bits, que refaz as operações sobre o arquivo original.
    #[test]
    fn anotacao_achatada_em_16_bits() {
        use crate::image::{encode, raster::Rgba16Image};
        let dir = std::env::temp_dir().join(format!("gvi-cor16-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p3.png");
        let opts = encode::ExportOptions {
            format: encode::ExportFormat::Png,
            quality: None,
            alpha: true,
            depth16: true,
            strip_metadata: false,
            resize: None,
            color_profile: None,
        };
        let meta = encode::MetaCarry {
            icc: Some(p3()),
            ..Default::default()
        };
        let img = Rgba16Image::from_pixel(4, 3, Rgba([51400, 25700, 12850, 65535]));
        std::fs::write(&path, encode::encode(&img, &opts, &meta).unwrap()).unwrap();
        let store = DocStore::new();
        let id = store.open_documents(&[path.to_string_lossy().into_owned()])[0].id;
        let png = solid_png(4, 3, [255, 0, 0, 255]);
        store.apply_op(id, Op::Composite { png }).unwrap();
        store.save(id, None).unwrap();
        let saved = ::image::open(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(saved.color(), ::image::ColorType::Rgb16);
        let p = saved.into_rgb16().get_pixel(0, 0).0;
        near([p[0], p[1], p[2], 65535].map(|v: u16| (v / 257) as u8), [234, 51, 35]);
    }

    #[test]
    fn nome_do_perfil_atual() {
        let (store, id) = store_with(Some(p3()));
        let name = |store: &DocStore| store.with_doc(id, |d| d.profile_name()).unwrap();
        assert_eq!(name(&store), Some((String::new(), "Display P3".into())));
        let profile = "adobe-rgb".to_string();
        store.apply_op(id, Op::AssignProfile { profile }).unwrap();
        assert_eq!(name(&store), Some(("adobe-rgb".into(), "Adobe RGB (1998)".into())));
    }

    #[test]
    fn perfil_desconhecido_e_recusado() {
        let (store, id) = store_with(None);
        let op = Op::AssignProfile {
            profile: "nao-existe".into(),
        };
        assert_eq!(store.apply_op(id, op).unwrap_err().code(), "unsupported");
    }
}
