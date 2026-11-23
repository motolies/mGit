//! 비밀 정보 스캔 (CHG-09). staged diff 의 추가 줄만 검사한다.
//!
//! 규칙은 gitleaks (MIT, <https://github.com/gitleaks/gitleaks>, `config/gitleaks.toml`) 의 범용 규칙
//! 일부를 가져와 다듬었다. 고지는 저장소 루트 `THIRD-PARTY-NOTICES.md`.

use std::sync::OnceLock;

use mgit_git::cmd::staged_diff;
use mgit_l10n::tr;
use mgit_model::{LineKind, SecretHit, SecretIgnore};
use regex::Regex;

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;

/// 설정 키
const IGNORE_KEY: &str = "secrets.ignore";
/// 한 번에 돌려주는 적중 상한
const MAX_HITS: usize = 200;
/// 이 표시가 있는 줄은 건너뛴다
const ALLOW_MARKERS: &[&str] = &["mgit:allow-secret", "gitleaks:allow"];

/// (규칙 id, 정규식)
const RULES: &[(&str, &str)] = &[
    ("github-pat", r"ghp_[0-9a-zA-Z]{36}"),
    ("github-fine-grained-pat", r"github_pat_[0-9a-zA-Z_]{82}"),
    ("github-oauth", r"gho_[0-9a-zA-Z]{36}"),
    ("github-app-token", r"(?:ghu|ghs)_[0-9a-zA-Z]{36}"),
    ("gitlab-pat", r"glpat-[0-9a-zA-Z_\-]{20}"),
    (
        "aws-access-token",
        r"\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b",
    ),
    (
        "slack-bot-token",
        r"xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
    ),
    (
        "slack-user-token",
        r"xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}",
    ),
    (
        "slack-webhook",
        r"https://hooks\.slack\.com/(?:services|workflows)/[A-Za-z0-9+/]{43,56}",
    ),
    (
        "private-key",
        r"-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----",
    ),
    (
        "openai-api-key",
        r"sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}",
    ),
    ("anthropic-api-key", r"sk-ant-api03-[a-zA-Z0-9_\-]{93}AA"),
    (
        "stripe-key",
        r"\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b",
    ),
    ("google-api-key", r"AIza[0-9A-Za-z\-_]{35}"),
    (
        "sendgrid-api-token",
        r"SG\.[a-zA-Z0-9_\-]{22}\.[a-zA-Z0-9_\-]{43}",
    ),
    ("npm-access-token", r"npm_[a-zA-Z0-9]{36}"),
    (
        "pypi-upload-token",
        r"pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\-_]{50,1000}",
    ),
    ("hashicorp-vault-token", r"\bhvs\.[a-zA-Z0-9_\-]{90,}"),
    ("telegram-bot-token", r"\b[0-9]{8,10}:[a-zA-Z0-9_\-]{35}\b"),
    (
        "discord-bot-token",
        r"\b[MN][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27}\b",
    ),
    (
        "jwt",
        r"\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_\-]{17,}\.(?:[a-zA-Z0-9/\\_\-]{10,}={0,2})?",
    ),
    (
        "generic-api-key",
        r#"(?i)(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9+/=_\-]{16,}['"]"#,
    ),
];

/// 컴파일한 규칙 (한 번만)
fn rules() -> &'static [(&'static str, Regex)] {
    static CELL: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    CELL.get_or_init(|| {
        RULES
            .iter()
            .filter_map(|(id, re)| Regex::new(re).ok().map(|r| (*id, r)))
            .collect()
    })
}

/// 간단한 glob. `*` 는 `/` 를 뺀 임의 문자, `**` 는 임의 문자, `?` 는 한 글자.
/// 패턴에 `/` 가 없으면 파일 이름에만 맞춘다
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let mut re = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    re.push_str(".*");
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            other => re.push_str(&regex::escape(&other.to_string())),
        }
    }
    re.push('$');
    let Ok(r) = Regex::new(&re) else {
        return false;
    };
    let subject = if pattern.contains('/') {
        path
    } else {
        path.rsplit('/').next().unwrap_or(path)
    };
    r.is_match(subject)
}

/// 적중 문자열의 가운데를 가린다 (앞 4 + … + 뒤 2)
fn mask(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 8 {
        return "…".repeat(3);
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 2..].iter().collect();
    format!("{head}…{tail}")
}

/// 무시 규칙에 걸리는지
fn ignored(ignores: &[SecretIgnore], rule: &str, path: &str) -> bool {
    ignores.iter().any(|i| {
        let rule_ok = i.rule.as_deref().is_none_or(|r| r == rule);
        let path_ok = i.path.as_deref().is_none_or(|p| glob_match(p, path));
        (i.rule.is_some() || i.path.is_some()) && rule_ok && path_ok
    })
}

/// 줄 하나를 검사한다 (첫 적중 규칙만)
fn scan_line(text: &str) -> Option<(&'static str, String)> {
    if ALLOW_MARKERS.iter().any(|m| text.contains(m)) {
        return None;
    }
    for (id, re) in rules() {
        if let Some(m) = re.find(text) {
            return Some((id, mask(m.as_str())));
        }
    }
    None
}

impl Core {
    /// staged 변경의 추가 줄에서 비밀 정보를 찾는다 (CHG-09)
    pub async fn scan_staged_secrets(
        &self,
        session: SessionId,
    ) -> Result<Vec<SecretHit>, CoreError> {
        let inner = self.inner_arc();
        let s = inner.get(session)?;
        let files = staged_diff(inner.runner(), &s.info.work_tree).await?;
        let ignores = self.secret_ignores();
        let mut hits = Vec::new();
        'files: for f in &files {
            if f.binary.is_some() {
                continue;
            }
            let path = f
                .new_path
                .clone()
                .or_else(|| f.old_path.clone())
                .unwrap_or_default();
            for h in &f.hunks {
                for l in &h.lines {
                    if l.kind != LineKind::Add {
                        continue;
                    }
                    let Some((rule, snippet)) = scan_line(&l.text) else {
                        continue;
                    };
                    if ignored(&ignores, rule, &path) {
                        continue;
                    }
                    hits.push(SecretHit {
                        path: path.clone(),
                        line: l.new_no.unwrap_or(0),
                        rule: rule.to_string(),
                        snippet,
                    });
                    if hits.len() >= MAX_HITS {
                        break 'files;
                    }
                }
            }
        }
        Ok(hits)
    }

    /// 무시 규칙 (설정)
    pub fn secret_ignores(&self) -> Vec<SecretIgnore> {
        self.store()
            .setting_get(IGNORE_KEY)
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default()
    }

    /// 무시 규칙 저장
    pub fn set_secret_ignores(&self, list: &[SecretIgnore]) -> Result<(), CoreError> {
        let json = serde_json::to_string(list).map_err(|e| {
            CoreError::Invalid(tr!(
                "무시 규칙 직렬화 실패: {e}",
                "Failed to serialize ignore rules: {e}"
            ))
        })?;
        self.store().setting_set(IGNORE_KEY, &json)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_token_shapes() {
        let ghp = format!("token = \"ghp_{}\"", "a".repeat(36));
        assert_eq!(scan_line(&ghp).map(|(r, _)| r), Some("github-pat"));
        assert_eq!(
            scan_line("AKIAABCDEFGHIJKLMNOP").map(|(r, _)| r),
            Some("aws-access-token")
        );
        assert_eq!(
            scan_line("-----BEGIN OPENSSH PRIVATE KEY-----").map(|(r, _)| r),
            Some("private-key")
        );
        assert_eq!(
            scan_line("API_KEY = 'abcdefghijklmnopqrstuvwxyz0123'").map(|(r, _)| r),
            Some("generic-api-key")
        );
        assert!(scan_line("let x = 1; // 평범한 코드").is_none());
        assert!(scan_line(&format!("{ghp} // gitleaks:allow")).is_none());
        let (_, snippet) = scan_line(&ghp).unwrap_or(("", String::new()));
        assert!(snippet.starts_with("ghp_") && snippet.contains('…') && snippet.len() < 12);
    }

    #[test]
    fn glob_and_ignores() {
        assert!(glob_match("*.lock", "a/b/Cargo.lock"));
        assert!(!glob_match("*.lock", "a/b/lock.txt"));
        assert!(glob_match("docs/**", "docs/a/b.md"));
        assert!(!glob_match("docs/*", "docs/a/b.md"));
        assert!(glob_match("src/?.rs", "src/a.rs"));
        let ig = vec![
            SecretIgnore {
                rule: Some("jwt".into()),
                path: None,
            },
            SecretIgnore {
                rule: None,
                path: Some("fixtures/**".into()),
            },
            SecretIgnore {
                rule: Some("github-pat".into()),
                path: Some("*.md".into()),
            },
        ];
        assert!(ignored(&ig, "jwt", "x.rs"));
        assert!(ignored(&ig, "aws-access-token", "fixtures/k.txt"));
        assert!(ignored(&ig, "github-pat", "README.md"));
        assert!(!ignored(&ig, "github-pat", "src/main.rs"));
        assert!(!ignored(&[SecretIgnore::default()], "jwt", "x"));
    }
}
