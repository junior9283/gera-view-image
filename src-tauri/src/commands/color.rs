//! Lote 1 (Cor): correspondência de cor na exibição e Atribuir Perfil….
use super::blocking;
use crate::{
    doc::{
        model::{DocId, DocInfo, Op},
        store::DocStore,
    },
    error::AppResult,
    image::{icc, proof},
};
use serde::Serialize;
use tauri::State;

/// Perfil oferecido em Atribuir Perfil… (`id`: um de `icc::BUILTIN` ou caminho de um .icc).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorProfile {
    pub id: String,
    pub name: String,
}

/// Descrição do perfil do monitor em uso; `None` = sRGB presumido.
#[tauri::command]
pub fn display_profile() -> AppResult<Option<String>> {
    Ok(icc::display_name())
}

/// Perfis embutidos primeiro, depois os .icc RGB instalados no sistema.
#[tauri::command]
pub async fn list_profiles() -> AppResult<Vec<ColorProfile>> {
    blocking(|| Ok(profiles(icc::system_profiles()))).await
}

fn profiles(system: Vec<(String, String)>) -> Vec<ColorProfile> {
    let builtin = icc::BUILTIN.map(|(id, name)| (id.to_string(), name.to_string()));
    builtin
        .into_iter()
        .chain(
            system
                .into_iter()
                .filter(|(_, n)| !icc::BUILTIN.iter().any(|(_, b)| b == n)),
        )
        .map(|(id, name)| ColorProfile { id, name })
        .collect()
}

/// Perfil atual do documento (o atribuído ou o embutido, com `id` vazio); `None` = sRGB presumido.
#[tauri::command]
pub async fn document_profile(
    store: State<'_, DocStore>,
    id: DocId,
) -> AppResult<Option<ColorProfile>> {
    let p = store.with_doc(id, |d| d.profile_name())?;
    Ok(p.map(|(id, name)| ColorProfile { id, name }))
}

/// Atribuir Perfil…: reinterpreta os pixels com `profile` (operação que se desfaz).
#[tauri::command]
pub async fn assign_profile(
    store: State<'_, DocStore>,
    id: DocId,
    profile: String,
) -> AppResult<DocInfo> {
    let store = store.inner().clone();
    blocking(move || store.apply_op(id, Op::AssignProfile { profile })).await
}

/// Perfis de Prova de Cor com Perfil: os de `list_profiles` e também os CMYK e cinza instalados.
#[tauri::command]
pub async fn list_proof_profiles() -> AppResult<Vec<ColorProfile>> {
    blocking(|| Ok(proof::profiles().into_iter().map(|(id, name)| ColorProfile { id, name }).collect())).await
}

/// Perfil de prova do documento; `None` = nenhum.
#[tauri::command]
pub async fn proof_profile(store: State<'_, DocStore>, id: DocId) -> AppResult<Option<ColorProfile>> {
    Ok(store.proof(id)?.map(|p| ColorProfile { id: p.id, name: p.name }))
}

/// Troca o perfil de prova do documento (`profile` nulo = nenhum). Só muda a exibição.
#[tauri::command]
pub async fn set_proof_profile(
    store: State<'_, DocStore>,
    id: DocId,
    profile: Option<String>,
) -> AppResult<Option<ColorProfile>> {
    let store = store.inner().clone();
    let p = blocking(move || store.set_proof(id, profile.as_deref())).await?;
    Ok(p.map(|p| ColorProfile { id: p.id, name: p.name }))
}

/// Preferência "Correspondência de cor": liga ou desliga a conversão para a tela e relê o
/// perfil do monitor. Se algo mudou, as prévias abertas são refeitas.
#[tauri::command]
pub async fn set_color_management(store: State<'_, DocStore>, enabled: bool) -> AppResult<()> {
    let store = store.inner().clone();
    blocking(move || {
        let monitor = enabled.then(icc::monitor_profile).flatten();
        if icc::configure(enabled, monitor) {
            store.redisplay_all();
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lista_comeca_pelos_embutidos_sem_repetir_nomes() {
        let system = vec![
            ("/x/sRGB.icc".to_string(), "sRGB IEC61966-2.1".to_string()),
            ("/x/mon.icc".to_string(), "Monitor".to_string()),
        ];
        let list = profiles(system);
        assert_eq!(list[0].id, "srgb");
        assert_eq!(list.len(), icc::BUILTIN.len() + 1);
        assert_eq!(list.last().unwrap().id, "/x/mon.icc");
    }
}
