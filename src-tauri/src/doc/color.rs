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
            Op::AssignProfile { profile } => icc::profile_bytes(profile).ok(),
            _ => None,
        });
        match assigned {
            Some(b) => Some(Profile::Assigned(b)),
            None if self.source.icc.is_some() => Some(Profile::Embedded(self.source.clone())),
            None => None,
        }
    }
}

impl DocStore {
    /// Converte o RGBA de uma prévia do documento `id` para o perfil de exibição.
    pub fn to_display(&self, id: DocId, rgba: &mut [u8]) {
        let p = self.with_doc(id, Document::profile).ok().flatten();
        icc::to_display(rgba, p.as_ref().map(Profile::bytes));
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

    #[test]
    fn perfil_desconhecido_e_recusado() {
        let (store, id) = store_with(None);
        let op = Op::AssignProfile {
            profile: "nao-existe".into(),
        };
        assert_eq!(store.apply_op(id, op).unwrap_err().code(), "unsupported");
    }
}
