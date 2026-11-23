//! 빌드 멀티 모듈 (MOD-01~05): 빌드 도구 설정에서 모듈(하위 프로젝트)을 찾고, 범위 선택을 기억한다.
//! 감지는 파일 읽기만 하며 git 을 부르지 않는다

use std::path::Path;

use mgit_l10n::tr;
use serde::{Deserialize, Serialize};

use crate::core::Core;
use crate::error::CoreError;
use crate::events::SessionId;
use crate::messages;

/// 모듈을 알아낸 빌드 도구
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModuleKind {
    Gradle,
    Maven,
    Npm,
    Cargo,
    Go,
    Manual,
}

/// 모듈 하나
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub name: String,
    /// 작업 트리 기준 상대 경로 (`/` 구분, 끝 `/` 없음)
    pub path: String,
    pub kind: ModuleKind,
}

/// 수동 보정 (MOD-01): 직접 추가한 모듈과 숨긴 경로
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModuleOverrides {
    pub added: Vec<Module>,
    pub hidden: Vec<String>,
}

/// 글로브 확장 최대 깊이
const GLOB_DEPTH: usize = 4;

/// 경로를 `/` 구분·끝 `/` 없는 꼴로
fn norm(path: &str) -> String {
    path.trim()
        .trim_start_matches("./")
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

/// 따옴표 안의 문자열들
fn quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' || c == '"' {
            let mut s = String::new();
            for d in chars.by_ref() {
                if d == c {
                    break;
                }
                s.push(d);
            }
            if !s.is_empty() {
                out.push(s);
            }
        }
    }
    out
}

/// 여러 줄 `include` 가 끝났는지: 괄호 형식은 괄호가 닫혀야, 괄호 없는 형식은 줄 끝 쉼표가 없어야 끝이다
fn gradle_include_closed(acc: &str, line: &str) -> bool {
    let open = acc.matches('(').count();
    if open > 0 {
        acc.matches(')').count() >= open
    } else {
        !line.ends_with(',')
    }
}

/// Gradle `settings.gradle(.kts)`: `include ':a', ':b:c'` / `include("a")` → `a`, `b/c`.
/// 여러 줄 `include` 안의 빈 줄과 `//` 주석은 건너뛴다
pub fn parse_gradle_includes(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending: Option<String> = None;
    for raw in text.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        let starts = line.starts_with("include ") || line.starts_with("include(");
        if let Some(acc) = pending.as_mut() {
            if line.is_empty() {
                continue;
            }
            acc.push(' ');
            acc.push_str(line);
            if gradle_include_closed(acc, line) {
                let done = pending.take().unwrap_or_default();
                out.extend(quoted(&done));
            }
            continue;
        }
        if !starts || line.starts_with("includeBuild") {
            continue;
        }
        // 여러 줄 include( ... ) 또는 끝에 쉼표
        let open = line.matches('(').count();
        let close = line.matches(')').count();
        if (open > close) || line.ends_with(',') {
            pending = Some(line.to_string());
            continue;
        }
        out.extend(quoted(line));
    }
    out.into_iter()
        .map(|m| norm(&m.trim_start_matches(':').replace(':', "/")))
        .filter(|m| !m.is_empty())
        .collect()
}

/// Maven `pom.xml`: `<modules><module>x</module></modules>`
pub fn parse_maven_modules(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<module>") {
        let after = &rest[start + "<module>".len()..];
        let Some(end) = after.find("</module>") else {
            break;
        };
        let m = norm(&after[..end]);
        if !m.is_empty() {
            out.push(m);
        }
        rest = &after[end..];
    }
    out
}

/// `package.json` 의 `workspaces` (배열 또는 `{ packages: [...] }`)
pub fn parse_npm_workspaces(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let ws = match v.get("workspaces") {
        Some(serde_json::Value::Array(a)) => a.clone(),
        Some(serde_json::Value::Object(o)) => o
            .get("packages")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    ws.iter()
        .filter_map(|x| x.as_str())
        .map(norm)
        .filter(|s| !s.is_empty() && !s.starts_with('!'))
        .collect()
}

/// `pnpm-workspace.yaml` 의 `packages:` 목록
pub fn parse_pnpm_packages(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_list = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with("packages:") {
            in_list = true;
            continue;
        }
        if in_list {
            let t = line.trim_start();
            if let Some(item) = t.strip_prefix('-') {
                let item = item.split('#').next().unwrap_or("").trim();
                let item = item.trim_matches(|c| c == '"' || c == '\'');
                if !item.is_empty() && !item.starts_with('!') {
                    out.push(norm(item));
                }
            } else if !t.is_empty() {
                in_list = false;
            }
        }
    }
    out
}

/// `[workspace]` 섹션 안의 `members` 키가 시작하는 위치. 줄 맨 앞의 키만 본다
/// (`default-members`, 주석, 다른 키의 값은 아니다)
fn cargo_members_key(section: &str) -> Option<usize> {
    let mut offset = 0;
    for line in section.split_inclusive('\n') {
        let key = line.trim_start();
        if key
            .strip_prefix("members")
            .is_some_and(|rest| rest.trim_start().starts_with('='))
        {
            return Some(offset + line.len() - key.len());
        }
        offset += line.len();
    }
    None
}

/// `Cargo.toml` `[workspace] members = [...]`
pub fn parse_cargo_members(text: &str) -> Vec<String> {
    let Some(ws) = text.find("[workspace]") else {
        return Vec::new();
    };
    let section = &text[ws..];
    // 다음 섹션 헤더까지 (`[dependencies]`·`[workspace.dependencies]`·`[[bin]]` 등)
    let end = section.find("\n[").unwrap_or(section.len());
    let section = &section[..end];
    let Some(m) = cargo_members_key(section) else {
        return Vec::new();
    };
    let after = &section[m..];
    let Some(open) = after.find('[') else {
        return Vec::new();
    };
    let Some(close) = after[open..].find(']') else {
        return Vec::new();
    };
    quoted(&after[open..open + close])
        .into_iter()
        .map(|s| norm(&s))
        .filter(|s| !s.is_empty())
        .collect()
}

/// `go.work` 의 `use` 항목
pub fn parse_go_use(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_block = false;
    for raw in text.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if in_block {
            if line == ")" {
                in_block = false;
            } else if !line.is_empty() {
                out.push(norm(line));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("use") {
            let rest = rest.trim();
            if rest == "(" {
                in_block = true;
            } else if !rest.is_empty() {
                out.push(norm(rest));
            }
        }
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

/// `a/*`·`a/**` 꼴 패턴을 실제 디렉터리로 펼친다. `marker` 가 있으면 그 파일이 있는 디렉터리만
fn expand(work_tree: &Path, pattern: &str, marker: Option<&str>) -> Vec<String> {
    let has_marker = |dir: &Path| marker.is_none_or(|m| dir.join(m).is_file());
    if !pattern.contains('*') {
        let dir = work_tree.join(pattern);
        return if dir.is_dir() && has_marker(&dir) {
            vec![pattern.to_string()]
        } else {
            Vec::new()
        };
    }
    let (prefix, rest) = match pattern.find('*') {
        Some(i) => {
            let p = &pattern[..i];
            let base = p.rsplit_once('/').map(|(b, _)| b).unwrap_or("");
            (base.to_string(), &pattern[base.len()..])
        }
        None => (pattern.to_string(), ""),
    };
    let deep = rest.contains("**");
    let base_dir = if prefix.is_empty() {
        work_tree.to_path_buf()
    } else {
        work_tree.join(&prefix)
    };
    let mut out = Vec::new();
    /// 디렉터리를 걷는다
    fn walk(
        dir: &Path,
        rel: &str,
        depth: usize,
        deep: bool,
        has_marker: &dyn Fn(&Path) -> bool,
        out: &mut Vec<String>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut names: Vec<_> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.') && n != "node_modules" && n != "target")
            .collect();
        names.sort();
        for n in names {
            let p = dir.join(&n);
            let r = if rel.is_empty() {
                n.clone()
            } else {
                format!("{rel}/{n}")
            };
            if has_marker(&p) {
                out.push(r.clone());
            }
            if deep && depth + 1 < GLOB_DEPTH {
                walk(&p, &r, depth + 1, deep, has_marker, out);
            }
        }
    }
    walk(&base_dir, &prefix, 0, deep, &has_marker, &mut out);
    out
}

/// 빌드 설정에서 모듈을 찾는다 (MOD-01). 경로순, 중복 제거
pub fn detect_modules(work_tree: &Path) -> Vec<Module> {
    let read = |name: &str| std::fs::read_to_string(work_tree.join(name)).ok();
    let mut found: Vec<Module> = Vec::new();
    let mut push = |paths: Vec<String>, kind: ModuleKind| {
        for p in paths {
            if p.is_empty() || !work_tree.join(&p).is_dir() {
                continue;
            }
            if found.iter().any(|m| m.path == p) {
                continue;
            }
            let name = p.rsplit('/').next().unwrap_or(&p).to_string();
            found.push(Module {
                name,
                path: p,
                kind,
            });
        }
    };
    for f in ["settings.gradle.kts", "settings.gradle"] {
        if let Some(t) = read(f) {
            push(parse_gradle_includes(&t), ModuleKind::Gradle);
            break;
        }
    }
    if let Some(t) = read("pom.xml") {
        push(parse_maven_modules(&t), ModuleKind::Maven);
    }
    if let Some(t) = read("pnpm-workspace.yaml") {
        let paths = parse_pnpm_packages(&t)
            .iter()
            .flat_map(|p| expand(work_tree, p, Some("package.json")))
            .collect();
        push(paths, ModuleKind::Npm);
    }
    if let Some(t) = read("package.json") {
        let paths = parse_npm_workspaces(&t)
            .iter()
            .flat_map(|p| expand(work_tree, p, Some("package.json")))
            .collect();
        push(paths, ModuleKind::Npm);
    }
    if let Some(t) = read("Cargo.toml") {
        let paths = parse_cargo_members(&t)
            .iter()
            .flat_map(|p| expand(work_tree, p, Some("Cargo.toml")))
            .collect();
        push(paths, ModuleKind::Cargo);
    }
    if let Some(t) = read("go.work") {
        push(parse_go_use(&t), ModuleKind::Go);
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// 설정 키
fn overrides_key(work_tree: &Path) -> String {
    format!("modules:{}", work_tree.display())
}

/// 범위 설정 키
fn scope_key(work_tree: &Path) -> String {
    format!("module-scope:{}", work_tree.display())
}

impl Core {
    /// 모듈 목록 (MOD-01·02): 감지 + 수동 추가 − 숨김
    pub fn modules(&self, session: SessionId) -> Result<Vec<Module>, CoreError> {
        let s = self.inner_arc().get(session)?;
        let o = self.module_overrides(session)?;
        let mut list = detect_modules(&s.info.work_tree);
        for m in o.added {
            if !list.iter().any(|x| x.path == m.path) {
                list.push(Module {
                    kind: ModuleKind::Manual,
                    ..m
                });
            }
        }
        list.retain(|m| !o.hidden.iter().any(|h| h == &m.path));
        list.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(list)
    }

    /// 수동 보정
    pub fn module_overrides(&self, session: SessionId) -> Result<ModuleOverrides, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(self
            .store()
            .setting_get(&overrides_key(&s.info.work_tree))
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default())
    }

    /// 수동 보정 저장
    pub fn set_module_overrides(
        &self,
        session: SessionId,
        overrides: &ModuleOverrides,
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get(session)?;
        for m in &overrides.added {
            let p = norm(&m.path);
            if p.is_empty() || p.contains("..") || Path::new(&p).is_absolute() {
                return Err(CoreError::Invalid(tr!(
                    "잘못된 모듈 경로: {:?}",
                    "Invalid module path: {:?}",
                    m.path
                )));
            }
        }
        let cleaned = ModuleOverrides {
            added: overrides
                .added
                .iter()
                .map(|m| Module {
                    name: if m.name.trim().is_empty() {
                        norm(&m.path).rsplit('/').next().unwrap_or("").to_string()
                    } else {
                        m.name.trim().to_string()
                    },
                    path: norm(&m.path),
                    kind: ModuleKind::Manual,
                })
                .collect(),
            hidden: overrides.hidden.iter().map(|h| norm(h)).collect(),
        };
        let json = serde_json::to_string(&cleaned)
            .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
        self.store()
            .setting_set(&overrides_key(&s.info.work_tree), &json)?;
        Ok(())
    }

    /// 기억한 모듈 범위 (MOD-05)
    pub fn module_scope(&self, session: SessionId) -> Result<Option<String>, CoreError> {
        let s = self.inner_arc().get(session)?;
        Ok(self
            .store()
            .setting_get(&scope_key(&s.info.work_tree))
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str::<Option<String>>(&j).ok())
            .flatten())
    }

    /// 모듈 범위 기억 (None 이면 전체)
    pub fn set_module_scope(
        &self,
        session: SessionId,
        path: Option<&str>,
    ) -> Result<(), CoreError> {
        let s = self.inner_arc().get(session)?;
        let value: Option<String> = path.map(norm).filter(|p| !p.is_empty());
        let json = serde_json::to_string(&value)
            .map_err(|e| CoreError::Invalid(messages::settings_serialize_failed(&e)))?;
        self.store()
            .setting_set(&scope_key(&s.info.work_tree), &json)?;
        Ok(())
    }
}

/// 모듈 설정 파일이 바뀌었는지 볼 때 쓰는 후보 (감시·재감지용)
pub fn module_config_files() -> &'static [&'static str] {
    &[
        "settings.gradle.kts",
        "settings.gradle",
        "pom.xml",
        "package.json",
        "pnpm-workspace.yaml",
        "Cargo.toml",
        "go.work",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_members_key_is_exact_and_stays_in_workspace_section() {
        // `default-members` 는 `members` 키가 아니다
        assert_eq!(
            parse_cargo_members(
                "[workspace]\ndefault-members = [\"app\"]\nmembers = [\"app\", \"lib\"]\n"
            ),
            vec!["app", "lib"]
        );
        // 주석도 키가 아니다
        assert_eq!(
            parse_cargo_members("[workspace]\n# members = [\"old\"]\nmembers = [\"new\"]\n"),
            vec!["new"]
        );
        // 다음 섹션의 `members` 는 워크스페이스 값이 아니다
        assert!(
            parse_cargo_members(
                "[workspace]\nresolver = \"2\"\n\n[package.metadata.x]\nmembers = [\"ghost\"]\n"
            )
            .is_empty()
        );
    }

    #[test]
    fn gradle_multiline_include_survives_blank_lines_and_comments() {
        assert_eq!(
            parse_gradle_includes("include(\n    \":a\",\n\n    \":b\"\n)\n"),
            vec!["a", "b"]
        );
        assert_eq!(
            parse_gradle_includes("include(\n    // core\n    \":a\",\n    \":b\" // tail\n)\n"),
            vec!["a", "b"]
        );
        assert_eq!(
            parse_gradle_includes("include ':a', // core\n    ':b'\ninclude ':c'\n"),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn parses_gradle_maven_npm_cargo_go() {
        assert_eq!(
            parse_gradle_includes(
                "rootProject.name = 'x'\ninclude ':app', ':libs:core'\ninclude(\"web\")\nincludeBuild('../other')\ninclude(\n  \":a\",\n  \":b\"\n)\n"
            ),
            vec!["app", "libs/core", "web", "a", "b"]
        );
        assert_eq!(
            parse_maven_modules(
                "<project><modules>\n  <module>core</module>\n <module>./web/</module></modules></project>"
            ),
            vec!["core", "web"]
        );
        assert_eq!(
            parse_npm_workspaces(r#"{"workspaces": ["packages/*", "!packages/skip"]}"#),
            vec!["packages/*"]
        );
        assert_eq!(
            parse_npm_workspaces(r#"{"workspaces": {"packages": ["apps/web"]}}"#),
            vec!["apps/web"]
        );
        assert_eq!(
            parse_pnpm_packages(
                "packages:\n  - 'packages/*'\n  - \"apps/**\" # 주석\n  - '!**/test'\nother: 1\n"
            ),
            vec!["packages/*", "apps/**"]
        );
        assert_eq!(
            parse_cargo_members(
                "[package]\nname = \"x\"\n[workspace]\nresolver = \"3\"\nmembers = [\n  \"crates/*\",\n  \"apps/desktop\",\n]\nexclude = [\"old\"]\n[workspace.dependencies]\nfoo = \"1\"\n"
            ),
            vec!["crates/*", "apps/desktop"]
        );
        assert_eq!(
            parse_go_use("go 1.22\n\nuse ./svc\nuse (\n  ./lib // 주석\n  ./tools\n)\n"),
            vec!["svc", "lib", "tools"]
        );
        assert!(parse_cargo_members("[package]\nname = \"x\"\n").is_empty());
    }
}
