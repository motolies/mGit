use crate::repo::TestRepo;

/// 미리 정의한 저장소 모양
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    /// main 에 n 개 커밋
    Linear(u32),
    /// main 2개, feature 분기 1개, main 으로 `--no-ff` 머지. 태그 2종
    BranchMerge,
    /// main 1개, b1·b2 각 1개, 옥토퍼스 머지 (부모 3개)
    Octopus,
    /// main 2개 + 고아 브랜치 `docs` 1개
    Orphan,
    /// 한글 브랜치·메시지(NFC·NFD)·NFD 경로
    Korean,
    /// 두 번째 커밋 메시지가 빈 문자열
    EmptyMessage,
    /// `git init` 만 (unborn HEAD)
    Empty,
}

/// 시나리오대로 저장소를 만든다
pub fn build(scenario: Scenario) -> TestRepo {
    let mut r = TestRepo::init();
    match scenario {
        Scenario::Linear(n) => {
            for i in 1..=n {
                r.commit(&format!("commit {i}"));
            }
        }
        Scenario::BranchMerge => {
            r.commit("c1 base");
            r.tag("v0.1", false);
            r.commit("c2 main");
            r.checkout("v0.1");
            r.checkout_new("feature");
            r.commit("c3 feature");
            r.checkout("main");
            r.merge(&["feature"], "merge feature");
            r.tag("v1.0", true);
        }
        Scenario::Octopus => {
            r.commit("c1 base");
            r.checkout_new("b1");
            r.commit("c2 on b1");
            r.checkout("main");
            r.checkout_new("b2");
            r.commit("c3 on b2");
            r.checkout("main");
            r.merge(&["b1", "b2"], "octopus merge");
        }
        Scenario::Orphan => {
            r.commit("c1");
            r.commit("c2");
            r.checkout_orphan("docs");
            r.commit("docs root");
            r.checkout("main");
        }
        Scenario::Korean => {
            r.commit("첫 커밋 (NFC 한글)");
            r.checkout_new("기능/한글");
            // NFD: '한' = ㅎ+ㅏ+ㄴ 분해형
            r.write_file("\u{1112}\u{1161}\u{11AB}글/파일.txt", "nfd path");
            r.commit("\u{1112}\u{1161}\u{11AB}글 NFD 메시지");
            r.checkout("main");
        }
        Scenario::EmptyMessage => {
            r.commit("first");
            r.commit("");
        }
        Scenario::Empty => {}
    }
    r
}
