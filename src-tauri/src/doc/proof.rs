//! Prova de Cor por documento (L12): só muda o que o visor e a lupa mostram. O perfil fica no
//! `Document`, então acompanha a aba entre janelas e some quando o documento fecha. Miniaturas,
//! conta-gotas, achatamento, Salvar e Exportar usam sempre `render_view`/pixels sem prova.
use super::{
    color::Profile,
    model::{DocId, Rect},
    store::{DocStore, Document},
};
use crate::{
    error::AppResult,
    image::{
        icc,
        proof::{self, Proof},
        thumb,
    },
};

impl DocStore {
    /// Como `to_display`, passando pelo perfil de prova do documento, se houver.
    pub fn to_screen(&self, id: DocId, rgba: &mut [u8]) {
        let (profile, proof) = self
            .with_doc(id, |d| (Document::profile(d), d.proof.clone()))
            .unwrap_or_default();
        let doc = profile.as_ref().map(Profile::bytes);
        if !proof.is_some_and(|p| proof::to_display(rgba, doc, &p)) {
            icc::to_display(rgba, doc);
        }
    }

    /// `render_view` do visor e da lupa: com a prova de cor.
    pub fn render_screen(
        &self,
        id: DocId,
        frame: u32,
        max_w: u32,
        max_h: u32,
        region: Option<Rect>,
    ) -> AppResult<Vec<u8>> {
        let (mut buf, _) = self.render_view_state(id, frame, max_w, max_h, region)?;
        self.to_screen(id, &mut buf[thumb::HEADER_LEN..]);
        Ok(buf)
    }

    /// Perfil de prova do documento.
    pub fn proof(&self, id: DocId) -> AppResult<Option<Proof>> {
        self.with_doc(id, |d| d.proof.clone())
    }

    /// Troca o perfil de prova (`None` = nenhum) e avisa a interface para redesenhar. Lê o disco.
    pub fn set_proof(&self, id: DocId, profile: Option<&str>) -> AppResult<Option<Proof>> {
        let next = profile.map(proof::load).transpose()?;
        let (_, info) = self.with_doc_mut(id, |d| d.proof = next.clone())?;
        self.notify(&info);
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        doc::model::{Op, SourceFormat},
        image::{
            decode::Decoded,
            test_util::{TempDir, cmyk_profile},
        },
    };
    use ::image::{Rgba, RgbaImage};

    fn store() -> (DocStore, DocId) {
        let store = DocStore::new();
        let img = RgbaImage::from_pixel(4, 3, Rgba([255, 0, 0, 255]));
        let id = store.insert_decoded("", Decoded::single(img, SourceFormat::Png)).id;
        (store, id)
    }

    fn px(buf: Vec<u8>) -> [u8; 4] {
        buf[8..12].try_into().unwrap()
    }

    #[test]
    fn so_o_visor_mostra_a_prova_e_o_documento_nao_muda() {
        let dir = TempDir::new("doc-prova");
        let p = dir.path().join("Papel.icc");
        std::fs::write(&p, cmyk_profile("Papel não revestido")).unwrap();
        let (store, id) = store();
        let antes = store.info(id).unwrap();
        let set = store.set_proof(id, p.to_str()).unwrap().unwrap();
        assert_eq!((set.id.as_str(), set.name.as_str()), (p.to_str().unwrap(), "Papel não revestido"));
        assert_eq!(store.proof(id).unwrap(), Some(set));
        let depois = store.info(id).unwrap();
        assert!(depois.rev > antes.rev, "o visor redesenha");
        assert!(!depois.dirty && !depois.can_undo, "não é uma alteração");
        let tela = px(store.render_screen(id, 0, 9, 9, None).unwrap());
        assert!(tela[0].abs_diff(tela[1]) <= 3, "cinza na prova: {tela:?}");
        for sem in [store.render_view(id, 0, 9, 9, None), store.thumbnail(id, 0, 9)] {
            assert_eq!(px(sem.unwrap()), [255, 0, 0, 255]);
        }
        assert_eq!(store.render_full(id, 0).unwrap().get_pixel(0, 0).0, [255, 0, 0, 255]);
        // Vale por documento.
        let img = RgbaImage::from_pixel(1, 1, Rgba([255, 0, 0, 255]));
        let outro = store.insert_decoded("", Decoded::single(img, SourceFormat::Png)).id;
        assert_eq!(px(store.render_screen(outro, 0, 9, 9, None).unwrap()), [255, 0, 0, 255]);
        // Sobrevive a editar e desfazer; Nenhum volta ao normal.
        store.apply_op(id, Op::FlipH).unwrap();
        store.undo(id).unwrap();
        assert!(store.proof(id).unwrap().is_some());
        assert_eq!(store.set_proof(id, None).unwrap(), None);
        assert_eq!(px(store.render_screen(id, 0, 9, 9, None).unwrap()), [255, 0, 0, 255]);
    }

    #[test]
    fn perfil_invalido_mantem_o_atual() {
        let (store, id) = store();
        store.set_proof(id, Some("display-p3")).unwrap();
        assert!(store.set_proof(id, Some("/etc/passwd")).is_err());
        assert_eq!(store.proof(id).unwrap().unwrap().id, "display-p3");
        assert!(store.set_proof(DocId(99_999), None).is_err());
    }
}
