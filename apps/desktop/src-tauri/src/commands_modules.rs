//! 빌드 멀티 모듈 커맨드 (Phase 2 C3)

use mgit_core::{Module, ModuleKind, ModuleOverrides, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// 모듈 종류
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ModuleKindDto {
    Gradle,
    Maven,
    Npm,
    Cargo,
    Go,
    Manual,
}

impl From<ModuleKind> for ModuleKindDto {
    /// 코어 → wire
    fn from(k: ModuleKind) -> Self {
        match k {
            ModuleKind::Gradle => ModuleKindDto::Gradle,
            ModuleKind::Maven => ModuleKindDto::Maven,
            ModuleKind::Npm => ModuleKindDto::Npm,
            ModuleKind::Cargo => ModuleKindDto::Cargo,
            ModuleKind::Go => ModuleKindDto::Go,
            ModuleKind::Manual => ModuleKindDto::Manual,
        }
    }
}

/// 모듈
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDto {
    pub name: String,
    pub path: String,
    pub kind: ModuleKindDto,
}

impl From<Module> for ModuleDto {
    /// 코어 → wire
    fn from(m: Module) -> Self {
        ModuleDto {
            name: m.name,
            path: m.path,
            kind: m.kind.into(),
        }
    }
}

/// 수동 보정
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleOverridesDto {
    pub added: Vec<ModuleDto>,
    pub hidden: Vec<String>,
}

/// 모듈 목록 (MOD-01·02)
#[tauri::command]
#[specta::specta]
pub async fn modules(state: State<'_, AppState>, session: u32) -> Result<Vec<ModuleDto>, IpcError> {
    Ok(state
        .core()?
        .core
        .modules(SessionId(session))?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// 수동 보정
#[tauri::command]
#[specta::specta]
pub async fn module_overrides(
    state: State<'_, AppState>,
    session: u32,
) -> Result<ModuleOverridesDto, IpcError> {
    let o = state.core()?.core.module_overrides(SessionId(session))?;
    Ok(ModuleOverridesDto {
        added: o.added.into_iter().map(Into::into).collect(),
        hidden: o.hidden,
    })
}

/// 수동 보정 저장
#[tauri::command]
#[specta::specta]
pub async fn module_overrides_set(
    state: State<'_, AppState>,
    session: u32,
    overrides: ModuleOverridesDto,
) -> Result<(), IpcError> {
    let o = ModuleOverrides {
        added: overrides
            .added
            .into_iter()
            .map(|m| Module {
                name: m.name,
                path: m.path,
                kind: ModuleKind::Manual,
            })
            .collect(),
        hidden: overrides.hidden,
    };
    state
        .core()?
        .core
        .set_module_overrides(SessionId(session), &o)?;
    Ok(())
}

/// 기억한 모듈 범위 (MOD-05)
#[tauri::command]
#[specta::specta]
pub async fn module_scope(
    state: State<'_, AppState>,
    session: u32,
) -> Result<Option<String>, IpcError> {
    Ok(state.core()?.core.module_scope(SessionId(session))?)
}

/// 모듈 범위 기억
#[tauri::command]
#[specta::specta]
pub async fn module_scope_set(
    state: State<'_, AppState>,
    session: u32,
    path: Option<String>,
) -> Result<(), IpcError> {
    state
        .core()?
        .core
        .set_module_scope(SessionId(session), path.as_deref())?;
    Ok(())
}
