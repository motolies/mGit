use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 커밋 서명 설정 (CHG-08): `gpg.format`·`user.signingKey`·`commit.gpgSign`·`tag.gpgSign`
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    /// openpgp(기본)·x509·ssh
    pub format: String,
    pub signing_key: Option<String>,
    pub commit_sign: bool,
    pub tag_sign: bool,
}

/// 서명 검증 결과 (`%G?`): G 유효 / B 잘못됨 / U 신뢰 불명 / X·Y 만료 / R 폐기 / E 검증 불가 / N 없음
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignatureStatus {
    pub code: String,
    pub signer: String,
    pub key: String,
}

/// 비밀 정보 적중 (CHG-09)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretHit {
    pub path: String,
    /// 새 파일 기준 줄 번호
    pub line: u32,
    pub rule: String,
    /// 가운데를 가린 적중 문자열
    pub snippet: String,
}

/// 비밀 스캔 무시 규칙 (CHG-09): 규칙 id · 경로 glob · 둘 다(그 경로의 그 규칙만)
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretIgnore {
    pub rule: Option<String>,
    pub path: Option<String>,
}

/// hook 파일 (REPO-07)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub name: String,
    pub path: PathBuf,
    pub executable: bool,
}

/// 상태 조회 최적화 (AD-07)
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerfStatus {
    pub fsmonitor: bool,
    pub untracked_cache: bool,
    pub tracked_files: u32,
    /// 추적 파일이 많은데 fsmonitor 가 꺼져 있으면 제안
    pub suggested: bool,
}

/// 저장소 설정 (REPO-07)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSettings {
    /// 유효한 값 (local → global → system)
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    /// 저장소(local)에만 있는 값
    pub local_user_name: Option<String>,
    pub local_user_email: Option<String>,
    pub hooks_path: Option<String>,
    pub hooks: Vec<HookInfo>,
    /// `.gitignore` 내용 (없으면 None)
    pub gitignore: Option<String>,
    pub perf: PerfStatus,
    /// 얕은 복제 (`.git/shallow`)
    pub shallow: bool,
    pub signing: SigningInfo,
}
