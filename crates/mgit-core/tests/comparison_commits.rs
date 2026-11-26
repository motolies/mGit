//! 커밋 차이 목록은 각 방향의 도달 가능한 이력 차이를 반환한다.
#![allow(clippy::unwrap_used)]
mod common;
use common::{collector, core, wait_finished};
use mgit_testkit::{Scenario, build};

/// 동일한 시점은 비고 선형 이력은 새 커밋이 한쪽에만 나타난다.
#[tokio::test]
async fn commit_difference_is_directional() {
    let core = core().await;
    let mut repo = build(Scenario::Linear(1));
    repo.write_file("a.txt", "first");
    let first = repo.commit("first");
    repo.write_file("a.txt", "second");
    let second = repo.commit("second");
    let (sink, mut rx) = collector();
    let opened = core.open_repo(repo.path(), sink).await.unwrap();
    wait_finished(&mut rx, opened.session).await;
    let newer = core
        .comparison_commits(opened.session, &second.to_hex(), &first.to_hex())
        .await
        .unwrap();
    assert_eq!(newer.0.len(), 1);
    assert_eq!(newer.0[0].1, "second");
    assert!(!newer.1);
    assert!(
        core.comparison_commits(opened.session, &first.to_hex(), &second.to_hex())
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        core.comparison_commits(opened.session, &first.to_hex(), &first.to_hex())
            .await
            .unwrap()
            .0
            .is_empty()
    );
}
