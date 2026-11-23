use std::collections::HashMap;

use serde::Serialize;

use crate::Oid;

/// HEAD 가 가리키는 것 (스냅샷용)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HeadRef {
    /// `refs/heads/...` 전체 이름
    Symbolic {
        target: String,
    },
    Detached {
        oid: Oid,
    },
}

/// 로컬 브랜치·태그·HEAD 의 스냅샷 (SF-03). 작업 트리·인덱스는 포함하지 않는다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefSnapshot {
    /// (`refs/heads/x` 또는 `refs/tags/x`, oid), 이름순
    pub refs: Vec<(String, Oid)>,
    pub head: HeadRef,
}

impl RefSnapshot {
    /// `git update-ref --stdin` 입력: `to` 로 가기 위해 `from` 대비 바뀐 ref 만 update/delete
    pub fn transition_script(from: &RefSnapshot, to: &RefSnapshot) -> String {
        let mut script = String::new();
        for (name, oid) in &to.refs {
            let same = from.refs.iter().any(|(n, o)| n == name && o == oid);
            if !same {
                script.push_str(&format!("update {name} {}\n", oid.to_hex()));
            }
        }
        for (name, _) in &from.refs {
            if !to.refs.iter().any(|(n, _)| n == name) {
                script.push_str(&format!("delete {name}\n"));
            }
        }
        script
    }
}

/// undo·redo 한 번의 적용 계획 (SF-03)
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefRollback {
    /// `git update-ref --stdin` 입력. 현재 값을 함께 적어 그 사이 바뀌면 실패한다
    pub script: String,
    /// 바꿀 HEAD. 그대로 두면 `None`
    pub head: Option<HeadRef>,
    /// 작업 뒤에 외부에서 바뀌어 건드리지 않은 ref (HEAD 는 `HEAD`)
    pub skipped: Vec<String>,
}

impl RefRollback {
    /// 할 일이 없는지
    pub fn is_empty(&self) -> bool {
        self.script.is_empty() && self.head.is_none()
    }
}

impl RefSnapshot {
    /// 한 작업이 `from` → `to` 로 바꾼 ref 만 골라, 지금(`current`) 값이 `from` 그대로인 것만 `to` 로 옮긴다
    pub fn rollback_plan(
        from: &RefSnapshot,
        to: &RefSnapshot,
        current: &RefSnapshot,
    ) -> RefRollback {
        let index =
            |snap: &'_ RefSnapshot| -> HashMap<String, Oid> { snap.refs.iter().cloned().collect() };
        let (was, goal, now) = (index(from), index(to), index(current));
        let mut names: Vec<&String> = was.keys().chain(goal.keys()).collect();
        names.sort_unstable();
        names.dedup();
        let mut plan = RefRollback::default();
        for name in names {
            let (w, g, n) = (was.get(name), goal.get(name), now.get(name));
            // 이 작업이 바꾸지 않았거나 이미 목표 값이면 할 일이 없다
            if w == g || n == g {
                continue;
            }
            if n != w {
                plan.skipped.push(name.clone());
                continue;
            }
            let line = match (g, n) {
                (Some(g), Some(n)) => format!("update {name} {} {}\n", g.to_hex(), n.to_hex()),
                (Some(g), None) => format!("create {name} {}\n", g.to_hex()),
                (None, Some(n)) => format!("delete {name} {}\n", n.to_hex()),
                (None, None) => continue,
            };
            plan.script.push_str(&line);
        }
        if from.head != to.head && current.head != to.head {
            if current.head == from.head {
                plan.head = Some(to.head.clone());
            } else {
                plan.skipped.push("HEAD".to_string());
            }
        }
        plan
    }
}

/// undo 스택 항목 요약 (프런트 표시용)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoEntryInfo {
    pub id: u64,
    /// 예: `reset --hard`, `rebase`, `branch -D feat`
    pub label: String,
    /// epoch 밀리초
    pub at: i64,
    /// 바뀐 ref 수 (HEAD 포함)
    pub changed: u32,
}

/// undo·redo 결과. 그 작업 뒤에 외부에서 바뀌어 되돌리지 않은 ref 를 함께 알린다
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub entry: UndoEntryInfo,
    /// 건너뛴 ref 전체 이름 (HEAD 는 `HEAD`)
    pub skipped: Vec<String>,
}

/// 백업 ref (SF-04): `refs/mgit/backup/<branch>/<ts>`
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRef {
    /// ref 전체 이름
    pub name: String,
    /// 원래 브랜치 (짧은 이름)
    pub branch: String,
    pub oid: Oid,
    /// 생성 시각 (epoch 초)
    pub created_at: i64,
    /// 만든 작업 (`rebase`, `reset` …)
    pub reason: String,
}

/// reflog 항목 (AD-02)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// `HEAD@{3}` 같은 짧은 selector
    pub selector: String,
    pub oid: Oid,
    /// `commit: msg`, `checkout: moving from a to b` …
    pub subject: String,
    /// epoch 초
    pub time: i64,
}

/// 커밋 메시지 템플릿 (CHG-07)
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitTemplate {
    pub name: String,
    pub body: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn transition_script_lists_only_changes() {
        let a = Oid::from_hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let b = Oid::from_hex(b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
        let from = RefSnapshot {
            refs: vec![("refs/heads/main".into(), a), ("refs/heads/old".into(), a)],
            head: HeadRef::Symbolic {
                target: "refs/heads/main".into(),
            },
        };
        let to = RefSnapshot {
            refs: vec![("refs/heads/main".into(), b), ("refs/tags/v1".into(), a)],
            head: HeadRef::Detached { oid: b },
        };
        let script = RefSnapshot::transition_script(&from, &to);
        assert_eq!(
            script,
            format!(
                "update refs/heads/main {}\nupdate refs/tags/v1 {}\ndelete refs/heads/old\n",
                b.to_hex(),
                a.to_hex()
            )
        );
        assert_eq!(RefSnapshot::transition_script(&to, &to), "");
    }

    /// 지정한 ref 들로 스냅샷을 만든다 (HEAD 는 main)
    fn snap(refs: &[(&str, Oid)]) -> RefSnapshot {
        RefSnapshot {
            refs: refs.iter().map(|(n, o)| ((*n).to_string(), *o)).collect(),
            head: HeadRef::Symbolic {
                target: "refs/heads/main".into(),
            },
        }
    }

    #[test]
    fn rollback_touches_only_refs_the_operation_changed() {
        let a = Oid::from_hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let b = Oid::from_hex(b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
        let c = Oid::from_hex(b"cccccccccccccccccccccccccccccccccccccccc").unwrap();
        // 작업: feat 를 만들고 old 를 지우고 topic 을 옮겼다. 그 뒤 외부에서 main·ext 가 바뀌었다
        let before = snap(&[
            ("refs/heads/main", a),
            ("refs/heads/old", a),
            ("refs/heads/topic", a),
        ]);
        let after = snap(&[
            ("refs/heads/feat", b),
            ("refs/heads/main", a),
            ("refs/heads/topic", b),
        ]);
        let current = snap(&[
            ("refs/heads/ext", c),
            ("refs/heads/feat", b),
            ("refs/heads/main", c),
            ("refs/heads/topic", b),
        ]);
        let plan = RefSnapshot::rollback_plan(&after, &before, &current);
        assert_eq!(plan.skipped, Vec::<String>::new());
        assert_eq!(plan.head, None);
        let mut lines: Vec<&str> = plan.script.lines().collect();
        lines.sort_unstable();
        assert_eq!(
            lines,
            [
                format!("create refs/heads/old {}", a.to_hex()),
                format!("delete refs/heads/feat {}", b.to_hex()),
                format!("update refs/heads/topic {} {}", a.to_hex(), b.to_hex()),
            ]
        );
    }

    #[test]
    fn rollback_skips_refs_changed_after_the_operation() {
        let a = Oid::from_hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let b = Oid::from_hex(b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
        let c = Oid::from_hex(b"cccccccccccccccccccccccccccccccccccccccc").unwrap();
        let before = snap(&[("refs/heads/main", a), ("refs/heads/gone", a)]);
        let after = snap(&[("refs/heads/main", b)]);
        // main 은 외부에서 더 나아갔고, gone 은 외부에서 다시 만들어졌다
        let current = snap(&[("refs/heads/main", c), ("refs/heads/gone", c)]);
        let plan = RefSnapshot::rollback_plan(&after, &before, &current);
        assert!(plan.script.is_empty(), "{plan:?}");
        assert_eq!(plan.skipped, ["refs/heads/gone", "refs/heads/main"]);
        assert!(plan.is_empty());
    }

    #[test]
    fn rollback_restores_head_only_when_it_is_still_where_the_operation_left_it() {
        let a = Oid::from_hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let before = snap(&[("refs/heads/main", a)]);
        let mut after = snap(&[("refs/heads/main", a)]);
        after.head = HeadRef::Detached { oid: a };
        // HEAD 가 그대로면 복원
        assert_eq!(
            RefSnapshot::rollback_plan(&after, &before, &after).head,
            Some(before.head.clone())
        );
        // 이미 목표 값이면 할 일 없음
        let done = RefSnapshot::rollback_plan(&after, &before, &before);
        assert!(done.is_empty() && done.skipped.is_empty(), "{done:?}");
        // 외부에서 다른 곳으로 옮겼으면 건너뛴다
        let mut moved = snap(&[("refs/heads/main", a)]);
        moved.head = HeadRef::Symbolic {
            target: "refs/heads/other".into(),
        };
        let plan = RefSnapshot::rollback_plan(&after, &before, &moved);
        assert_eq!(plan.head, None);
        assert_eq!(plan.skipped, ["HEAD"]);
    }
}
