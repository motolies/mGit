// 목이 흉내 내는 코어(Rust) 문구의 언어 (다국어 L5). 코어는 `mgit_l10n::pick`·`tr!` 로 화면 언어의 문구를 고른다.
// 목에는 Rust 가 없으므로, 앱이 화면 언어를 정하며 맞춘 `<html lang>` 을 부를 때마다 읽는다 (`@mgit/ipc` 는 `@mgit/ui` 에
// 의존하지 않는다). 영어 문구는 코어의 영어와 같게 쓴다. 커밋 제목·작성자 같은 장면 데이터는 고르지 않는다 — 한국어 그대로다.
// 흉내 내지 않는 것: 목 클라이언트를 만들 때 굳는 장면 데이터의 문구 (요약 실패 사유 등 — 언어를 정하기 전에 만든다)

/** 지금 화면 언어가 영어인지 (`<html lang="en">`). 문서가 없거나 다른 값이면 한국어로 친다 (테스트의 기본값) */
function isEnglish(): boolean {
  return typeof document !== 'undefined' && document.documentElement.lang === 'en';
}

/** 코어 `pick(ko, en)` 흉내: 화면 언어의 문구를 고른다. 문구는 부를 때마다 고른다 (언어를 바꾸면 다음 응답부터 바뀐다) */
export function pick(ko: string, en: string): string {
  return isEnglish() ? en : ko;
}

/** 일괄 작업의 건너뜀 사유 (코어 `folder_batch::reason` 과 일괄 commit 의 사유). 자기 문구와 비교할 때도 이것을 쓴다 */
export const mockReason = {
  /** 진행 중인 작업(merge·rebase 등)이나 해결하지 않은 충돌이 있다 */
  inProgress: () => pick('진행 중인 작업이 있음', 'Operation in progress'),
  /** 커밋하지 않은 변경이 있다 */
  dirty: () => pick('커밋하지 않은 변경이 있음', 'Uncommitted changes'),
  /** 업스트림이 없다 */
  noUpstream: () => pick('업스트림 없음', 'No upstream'),
  /** 이미 그 브랜치에 있다 */
  alreadyOnBranch: () => pick('이미 그 branch', 'Already on that branch'),
  /** push 할 commit 이 없다 */
  nothingToPush: () => pick('보낼 commit 없음', 'No commits to push'),
  /** 원격 브랜치가 없다 (`origin/x`) */
  remoteBranchMissing: (tracking: string) =>
    pick(`원격 branch 가 없음: ${tracking}`, `Remote branch not found: ${tracking}`),
  /** 일괄 commit: stage 된 변경이 없다 */
  nothingStaged: () => pick('stage 된 변경 없음', 'No staged changes'),
  /** branch 업데이트 (BR-09)·이름 바꾸기: 그 이름의 로컬 branch 가 없다 (코어 `reason::no_branch`) */
  noBranch: () => pick('branch 없음', 'No such branch'),
  /** 일괄 이름 바꾸기: 새 이름의 branch 가 이미 있다 (코어 `rename_args`) */
  nameTaken: (name: string) =>
    pick(`새 이름이 이미 있음: ${name}`, `New name already exists: ${name}`),
  /** branch 업데이트: 다른 워크트리에서 checkout 중 (코어 `NotUpdatable::OtherWorktree`) */
  otherWorktree: (path: string) =>
    pick(`다른 워크트리에서 checkout 중 (${path})`, `Checked out in another worktree (${path})`),
  /** branch 업데이트: 로컬이 앞섬 (코어 `branch_update::ahead_reason`) */
  ahead: (n: number) =>
    pick(`로컬이 앞섬 (⇡${n}), 받을 것 없음`, `Local is ahead (⇡${n}), nothing to update`),
  /** branch 업데이트: 갈라짐 (코어 `branch_update::diverged_reason`) */
  diverged: (ahead: number, behind: number) =>
    pick(
      `갈라져 갱신하지 않음 (⇡${ahead} ⇣${behind})`,
      `Diverged, not updated (⇡${ahead} ⇣${behind})`,
    ),
};
