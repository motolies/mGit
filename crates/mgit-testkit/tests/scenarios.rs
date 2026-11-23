//! 시나리오별 커밋 수와 결정성 확인
#![allow(clippy::unwrap_used)]

use mgit_testkit::{Scenario, build};

#[test]
fn linear_has_n_commits() {
    let mut r = build(Scenario::Linear(5));
    assert_eq!(r.rev_list_count(), 5);
}

#[test]
fn branch_merge_has_four_commits_and_tags() {
    let mut r = build(Scenario::BranchMerge);
    assert_eq!(r.rev_list_count(), 4);
    let tags = r.git_ok(["tag", "--list"]);
    assert!(tags.contains("v0.1") && tags.contains("v1.0"));
}

#[test]
fn octopus_merge_has_three_parents() {
    let mut r = build(Scenario::Octopus);
    let parents = r.git_ok(["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 4); // 자신 + 부모 3
}

#[test]
fn orphan_branch_is_separate_root() {
    let mut r = build(Scenario::Orphan);
    assert_eq!(r.rev_list_count(), 3);
    let roots = r.git_ok(["rev-list", "--all", "--max-parents=0"]);
    assert_eq!(roots.lines().count(), 2);
}

#[test]
fn empty_repo_has_unborn_head() {
    let mut r = build(Scenario::Empty);
    let out = r.git(["rev-parse", "--verify", "-q", "HEAD"]);
    assert!(!out.status.success());
}

#[test]
fn hashes_are_deterministic_across_builds() {
    let mut a = build(Scenario::BranchMerge);
    let mut b = build(Scenario::BranchMerge);
    assert_eq!(a.head(), b.head());
}

#[test]
fn dates_are_fixed() {
    let mut r = build(Scenario::Linear(2));
    let dates = r.git_ok(["log", "--format=%ct", "--all"]);
    let v: Vec<i64> = dates.lines().map(|l| l.parse().unwrap()).collect();
    assert_eq!(v, vec![1_700_000_120, 1_700_000_060]);
}
