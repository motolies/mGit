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
  /** push 의 새 업스트림: 분리 HEAD 라 보낼 branch 가 없다 (코어 `reason::detached`) */
  detached: () =>
    pick('분리된 HEAD 상태에서는 푸시할 수 없습니다', 'Cannot push from a detached HEAD'),
  /** push 의 새 업스트림: 원격이 하나도 없다 (코어 `messages::no_remotes`) */
  noRemotes: () =>
    pick(
      '원격 저장소가 없습니다. 먼저 원격 저장소를 추가하세요.',
      'No remotes. Add a remote first',
    ),
  /** push 의 새 업스트림: origin 이 없는데 원격을 고르지 않았다 (코어 `reason::remote_not_chosen`) */
  remoteNotChosen: () =>
    pick(
      'origin 이 없어 보낼 원격을 골라야 합니다',
      'No origin remote. Choose a remote to push to',
    ),
  /** push 의 새 업스트림: 고른 원격이 없다 (코어 `messages::unknown_remote`) */
  unknownRemote: (name: string) =>
    pick(`등록된 원격 저장소가 없습니다: ${name}`, `No such remote: ${name}`),
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
  /** 일괄 stash 저장: 저장할 변경이 없다 (코어 `folder_stash::why::no_changes`) */
  noStashChanges: () => pick('스태시할 변경이 없습니다', 'No changes to stash'),
  /** 일괄 stash 저장: 미추적 파일만 있는데 넣지 않기로 했다 (코어 `why::untracked_only`) */
  untrackedOnly: () =>
    pick(
      '미추적 파일만 있습니다 (미추적 파일 포함을 켜면 저장합니다)',
      'Only untracked files (turn on Include untracked files to stash them)',
    ),
  /** 일괄 stash 꺼내기: 그 묶음의 항목이 없다 (코어 `why::no_batch_stash`) */
  noBatchStash: () => pick('이 묶음의 스태시가 없습니다', 'No stash from this batch'),
};
