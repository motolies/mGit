//! 구문 검사 (CF-25): tree-sitter 로 파싱해 오류 노드(ERROR·MISSING) 수를 센다.
//! 문법은 소수 언어만 넣었고, 지원하지 않는 확장자는 `None` 을 돌려준다

use tree_sitter::{Language, Node, Parser, TreeCursor};

/// 구문 검사 결과
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxReport {
    /// 오류 노드 수
    pub errors: u32,
    /// 첫 오류 줄 (1부터)
    pub first_error_line: Option<u32>,
    /// 문법 이름 (`rust`, `typescript` …)
    pub language: &'static str,
}

/// 경로 확장자로 문법을 고른다
pub fn language_for(path: &str) -> Option<(&'static str, Language)> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    if ext == name.to_ascii_lowercase() {
        return None;
    }
    let (label, f) = match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => ("javascript", tree_sitter_javascript::LANGUAGE),
        "ts" | "mts" | "cts" => ("typescript", tree_sitter_typescript::LANGUAGE_TYPESCRIPT),
        "tsx" => ("tsx", tree_sitter_typescript::LANGUAGE_TSX),
        "rs" => ("rust", tree_sitter_rust::LANGUAGE),
        "py" | "pyi" => ("python", tree_sitter_python::LANGUAGE),
        "java" => ("java", tree_sitter_java::LANGUAGE),
        "go" => ("go", tree_sitter_go::LANGUAGE),
        "json" => ("json", tree_sitter_json::LANGUAGE),
        "yaml" | "yml" => ("yaml", tree_sitter_yaml::LANGUAGE),
        _ => return None,
    };
    Some((label, Language::new(f)))
}

/// 지원하는 확장자인지
pub fn supports(path: &str) -> bool {
    language_for(path).is_some()
}

/// 트리를 전위 순회한다
fn walk(cursor: &mut TreeCursor<'_>, f: &mut impl FnMut(Node<'_>)) {
    loop {
        f(cursor.node());
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

/// 파싱해 오류 노드를 센다. 지원하지 않는 확장자면 `None`
pub fn check(path: &str, source: &[u8]) -> Option<SyntaxReport> {
    let (language, lang) = language_for(path)?;
    let mut parser = Parser::new();
    parser.set_language(&lang).ok()?;
    let tree = parser.parse(source, None)?;
    let mut errors = 0u32;
    let mut first: Option<u32> = None;
    let mut cursor = tree.walk();
    walk(&mut cursor, &mut |n| {
        if n.is_error() || n.is_missing() {
            errors += 1;
            if first.is_none() {
                first = Some(n.start_position().row as u32 + 1);
            }
        }
    });
    Some(SyntaxReport {
        errors,
        first_error_line: first,
        language,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn counts_errors_per_language() {
        let ok = check("a.rs", b"fn main() { let x = 1; }\n").unwrap();
        assert_eq!(ok.errors, 0);
        assert_eq!(ok.language, "rust");
        let bad = check("a.rs", b"fn main() { let x = ; }\n").unwrap();
        assert!(bad.errors > 0);
        assert_eq!(bad.first_error_line, Some(1));
        assert_eq!(check("x.json", b"{\"a\": 1}").unwrap().errors, 0);
        assert!(check("x.json", b"{\"a\": }").unwrap().errors > 0);
        assert_eq!(check("x.ts", b"const a: number = 1;\n").unwrap().errors, 0);
        assert!(check("x.tsx", b"const a = <div>;\n").unwrap().errors > 0);
        assert_eq!(
            check("x.py", b"def f():\n    return 1\n").unwrap().errors,
            0
        );
        assert_eq!(
            check("x.go", b"package main\nfunc main() {}\n")
                .unwrap()
                .errors,
            0
        );
        assert_eq!(
            check("x.java", b"class A { void f() {} }\n")
                .unwrap()
                .errors,
            0
        );
        assert_eq!(check("x.yml", b"a: 1\nb:\n  - c\n").unwrap().errors, 0);
        assert_eq!(
            check("x.js", b"<<<<<<< ours\nlet a = 1;\n").map(|r| r.errors > 0),
            Some(true)
        );
        assert!(check("README.md", b"# hi").is_none());
        assert!(check("Makefile", b"all:").is_none());
    }
}
