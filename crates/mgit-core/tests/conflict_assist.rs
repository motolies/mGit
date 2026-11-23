//! 충돌 해결 보조 (CF-15~19·27~29)
#![allow(clippy::unwrap_used)]

mod common;

use common::{collector, core, wait_finished};
use mgit_core::{BlockClass, ConflictRule, ConflictSide, RuleAction, UnresolveMode};
use mgit_testkit::{Scenario, build};

#[tokio::test]
async fn rules_keep_review_reapply_and_rerere() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.prepare_conflict();
    repo.begin_merge_conflict();
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    // CF-15: 분류가 블록 수만큼 오고, 같은 줄을 다르게 바꿨으니 Real
    let p = core.conflict_file(id, "conflict.txt").await.unwrap();
    assert_eq!(p.auto.len(), p.doc.as_ref().unwrap().conflict_count());
    assert_eq!(p.auto[0].class, BlockClass::Real);
    assert!(p.auto[0].resolution.is_none());

    // CF-17: 출처 — 양쪽 commit 이 파일을 건드렸다
    let o = core.conflict_origins(id, "conflict.txt").await.unwrap();
    assert_eq!(o.ours.len(), 1, "{o:?}");
    assert_eq!(o.ours[0].subject, "main change");
    assert_eq!(o.theirs.len(), 1);
    assert_eq!(o.theirs[0].subject, "other change");
    assert!(o.current.is_none());

    // CF-18: 규칙 (union) 적용
    core.set_conflict_rules(
        id,
        &[ConflictRule {
            glob: "*.txt".into(),
            action: RuleAction::Union,
        }],
    )
    .unwrap();
    assert_eq!(core.conflict_rules(id).unwrap().len(), 1);
    let results = core.apply_conflict_rules(id).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].ok, "{results:?}");
    assert!(core.conflicts(id).await.unwrap().is_empty());
    let text = repo.read_file("conflict.txt");
    assert!(text.contains("OURS") && text.contains("THEIRS"), "{text}");

    // CF-28: 해결이 보관됐다
    let kept = core.kept_resolutions(id).await.unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].path, "conflict.txt");
    assert!(kept[0].matches_current);
    assert!(kept[0].stages.iter().all(Option::is_some));

    // CF-27: 자동 병합(충돌 있음) vs 저장본 diff
    let review = core.resolution_review(id, "conflict.txt").await.unwrap();
    assert!(review.auto_had_conflicts);
    assert!(review.auto.contains("<<<<<<<"));
    assert_eq!(review.resolved, text);
    assert!(review.diff.contains("-<<<<<<<"), "{}", review.diff);

    // 되돌린 뒤 재적용 (CF-28)
    core.unresolve(id, "conflict.txt", UnresolveMode::Remake)
        .await
        .unwrap();
    assert_eq!(core.conflicts(id).await.unwrap().len(), 1);
    assert_eq!(core.reapply_resolutions(id).await.unwrap(), 1);
    assert!(core.conflicts(id).await.unwrap().is_empty());
    assert_eq!(repo.read_file("conflict.txt"), text);

    // 명령 규칙: 파일을 통째로 바꾸고 stage
    core.unresolve(id, "conflict.txt", UnresolveMode::Remake)
        .await
        .unwrap();
    core.set_conflict_rules(
        id,
        &[ConflictRule {
            glob: "conflict.txt".into(),
            action: RuleAction::Command {
                cmd: "printf 'by command\\n' > \"$MGIT_PATH\"".into(),
            },
        }],
    )
    .unwrap();
    let results = core.apply_conflict_rules(id).await.unwrap();
    assert!(results[0].ok, "{results:?}");
    assert_eq!(repo.read_file("conflict.txt"), "by command\n");
    assert!(core.conflicts(id).await.unwrap().is_empty());
    assert_eq!(core.kept_resolutions(id).await.unwrap().len(), 1);

    // CF-29: rerere 설정 왕복
    let st = core.rerere_status(id).await.unwrap();
    assert!(!st.enabled);
    core.rerere_set(id, true, false).await.unwrap();
    let st = core.rerere_status(id).await.unwrap();
    assert!(st.enabled && !st.autoupdate);
    assert!(st.resolved_paths.is_empty());

    // 외부 병합 도구: 설정 없으면 안내 오류
    assert!(core.merge_tool_name(id).await.unwrap().is_none());
    assert!(core.open_mergetool(id, "conflict.txt").await.is_err());

    core.kept_clear(id).await.unwrap();
    assert!(core.kept_resolutions(id).await.unwrap().is_empty());
}

#[tokio::test]
async fn rename_rename_conflict_is_grouped_and_resolved_to_one_path() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("old.txt", "one\ntwo\nthree\nfour\nfive\n");
    repo.stage(&["old.txt"]);
    repo.commit_staged("add old");
    repo.checkout_new("side");
    repo.git_ok(["mv", "old.txt", "b.txt"]);
    repo.write_file("b.txt", "one\ntwo\nthree\nfour\nFIVE\n");
    repo.stage(&["b.txt"]);
    repo.commit_staged("rename to b");
    repo.checkout("main");
    repo.git_ok(["mv", "old.txt", "a.txt"]);
    repo.stage(&["a.txt"]);
    repo.commit_staged("rename to a");
    let out = repo.git(["merge", "--no-edit", "side"]);
    assert!(!out.status.success(), "rename/rename 충돌이 나야 한다");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let id = opened.session;

    let groups = core.rename_conflicts(id).await.unwrap();
    assert_eq!(groups.len(), 1, "{groups:?}");
    assert_eq!(groups[0].base_path, "old.txt");
    assert_eq!(groups[0].ours_path, "a.txt");
    assert_eq!(groups[0].theirs_path, "b.txt");

    let kept = core
        .resolve_rename(id, &groups[0], ConflictSide::Ours)
        .await
        .unwrap();
    assert_eq!(kept, "a.txt");
    let files = core.conflicts(id).await.unwrap();
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].path, "a.txt");
    assert!(files[0].stages.iter().all(Option::is_some));
    assert!(!repo.path().join("b.txt").exists());
    assert!(core.rename_conflicts(id).await.unwrap().is_empty());
    // 양쪽 수정 충돌로 열 수 있고, 내용은 겹치지 않아 깨끗이 합쳐진다
    let p = core.conflict_file(id, "a.txt").await.unwrap();
    assert_eq!(p.doc.as_ref().unwrap().conflict_count(), 0);
    assert!(p.worktree.as_deref().unwrap_or("").contains("FIVE"));
    core.resolve_file(id, "a.txt", p.worktree.unwrap().as_bytes(), false)
        .await
        .unwrap();
    assert!(core.conflicts(id).await.unwrap().is_empty());
}
