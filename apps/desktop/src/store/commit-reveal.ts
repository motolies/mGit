// 충돌이 생기면 Commit 도구 창을 한 번 연다 (WS-19, 사용자 결정 15번)의 순수 판정. 앱 스토어가 저장소 탭들의 충돌 수와
// 활성 탭이 바뀔 때마다 한 걸음씩 부르고(`watchCommitReveal`), 이 함수가 "지금 열라"고 하면 왼쪽 도구 창을 Commit 으로
// 바꾸고 그 변경 탭(충돌 목록)을 고른다 (`revealCommitChanges`, W23 — Stash 탭을 보던 중이어도 충돌 목록이 가려지지
// 않게) — 포커스·아래 도구 창(최대화 포함)은 건드리지 않는다.
//
// 규칙:
// - 계기: 저장소 탭의 충돌 수가 0 → 양수가 됨. 탭을 처음 볼 때(탭 열기·앱 시작·폴더 세션의 승격) 이미 충돌이 있어도
//   계기다 — 충돌 중인 저장소를 열면 충돌 목록을 보고 싶다.
// - 한 번만: 계기 하나에 한 번 연다. 그 뒤 사용자가 Project 로 돌아가면 충돌이 남아 있어도 다시 열지 않는다. 충돌이 0 이
//   됐다가 다시 생기면 새 계기다.
// - 그 탭이 활성 탭일 때만 연다: 왼쪽 도구 창은 앱 전역 1벌이라 다른 탭의 화면을 바꾸게 되므로, 비활성 탭의 계기는
//   남겨 두었다가 그 탭이 활성이 될 때 연다. 그 사이 충돌이 모두 풀렸으면 계기도 사라진다(열 까닭이 없다).
// - 폴더 탭은 대상이 아니다 (폴더 탭에는 저장소별 띠와 "충돌 해결"이 있다).

import type { SessionId } from '@mgit/ipc';

/** 저장소 탭 하나의 지금 충돌 수 */
export interface RepoTabConflicts {
  id: SessionId;
  conflicted: number;
}

/** 판정이 걸음 사이에 기억하는 것 */
export interface CommitRevealMemo {
  /** 저장소 탭마다 지난 걸음에서 본 충돌 수 (없으면 처음 보는 탭) */
  seen: ReadonlyMap<SessionId, number>;
  /** 계기가 있었지만 아직 열지 못한 탭 (비활성이었다) */
  pending: ReadonlySet<SessionId>;
}

/** 처음 상태: 본 탭도 남은 계기도 없다 */
export const EMPTY_COMMIT_REVEAL: CommitRevealMemo = { seen: new Map(), pending: new Set() };

/**
 * 한 걸음: 지금 저장소 탭들의 충돌 수와 활성 탭을 받아 계기를 갱신하고, 활성 탭에 남은 계기가 있으면 "지금 열라"
 * (`reveal`)고 답하며 그 계기를 지운다. 사라진 탭(닫힘)의 기억은 버린다. 활성 탭이 폴더 탭이거나 없으면 `active` 는
 * 그 id 또는 null 이고, 저장소 탭 목록에 없으므로 열지 않는다
 */
export function commitRevealStep(
  memo: CommitRevealMemo,
  input: { tabs: readonly RepoTabConflicts[]; active: SessionId | null },
): { memo: CommitRevealMemo; reveal: boolean } {
  const seen = new Map<SessionId, number>();
  const pending = new Set<SessionId>();
  for (const tab of input.tabs) {
    const before = memo.seen.get(tab.id);
    seen.set(tab.id, tab.conflicted);
    if (tab.conflicted <= 0) {
      continue;
    }
    const appeared = before === undefined || before <= 0;
    if (appeared || memo.pending.has(tab.id)) {
      pending.add(tab.id);
    }
  }
  const reveal = input.active !== null && pending.has(input.active);
  if (reveal && input.active !== null) {
    pending.delete(input.active);
  }
  return { memo: { seen, pending }, reveal };
}
