import { describe, expect, it } from 'vitest';
import {
  type CommitRevealMemo,
  commitRevealStep,
  EMPTY_COMMIT_REVEAL,
  type RepoTabConflicts,
} from '../store/commit-reveal';

// 충돌이 생기면 Commit 도구 창을 한 번 연다 (WS-19, 결정 15번)의 판정

/** 걸음을 차례로 밟고 걸음마다 "지금 열라"를 모은다 */
function walk(
  steps: { tabs: RepoTabConflicts[]; active: number | null }[],
  start: CommitRevealMemo = EMPTY_COMMIT_REVEAL,
): { reveals: boolean[]; memo: CommitRevealMemo } {
  let memo = start;
  const reveals: boolean[] = [];
  for (const input of steps) {
    const next = commitRevealStep(memo, input);
    memo = next.memo;
    reveals.push(next.reveal);
  }
  return { reveals, memo };
}

describe('충돌 자동 활성화 판정 (WS-19)', () => {
  it('활성 저장소 탭의 충돌 수가 0 → 양수가 되는 순간 한 번 연다. 양수 사이의 변화(2 → 1)로는 다시 열지 않는다', () => {
    const { reveals } = walk([
      { tabs: [{ id: 1, conflicted: 0 }], active: 1 },
      { tabs: [{ id: 1, conflicted: 2 }], active: 1 },
      { tabs: [{ id: 1, conflicted: 2 }], active: 1 },
      { tabs: [{ id: 1, conflicted: 1 }], active: 1 },
    ]);
    expect(reveals).toEqual([false, true, false, false]);
  });

  it('0 이 됐다가 다시 생기면 새 계기다', () => {
    const { reveals } = walk([
      { tabs: [{ id: 1, conflicted: 0 }], active: 1 },
      { tabs: [{ id: 1, conflicted: 1 }], active: 1 },
      { tabs: [{ id: 1, conflicted: 0 }], active: 1 },
      { tabs: [{ id: 1, conflicted: 3 }], active: 1 },
    ]);
    expect(reveals).toEqual([false, true, false, true]);
  });

  it('탭을 처음 볼 때(탭 열기·앱 시작·승격) 이미 충돌이 있으면 0 → 양수와 같다. 충돌이 없으면 열지 않는다', () => {
    expect(walk([{ tabs: [{ id: 7, conflicted: 2 }], active: 7 }]).reveals).toEqual([true]);
    expect(walk([{ tabs: [{ id: 7, conflicted: 0 }], active: 7 }]).reveals).toEqual([false]);
  });

  it('비활성 탭의 계기는 남겨 두었다가 그 탭이 활성이 될 때 한 번 쓴다 (다른 탭의 화면은 바꾸지 않는다)', () => {
    const { reveals, memo } = walk([
      {
        tabs: [
          { id: 1, conflicted: 0 },
          { id: 2, conflicted: 0 },
        ],
        active: 1,
      },
      {
        tabs: [
          { id: 1, conflicted: 0 },
          { id: 2, conflicted: 2 },
        ],
        active: 1,
      },
      {
        tabs: [
          { id: 1, conflicted: 0 },
          { id: 2, conflicted: 2 },
        ],
        active: 2,
      },
      {
        tabs: [
          { id: 1, conflicted: 0 },
          { id: 2, conflicted: 2 },
        ],
        active: 1,
      },
      {
        tabs: [
          { id: 1, conflicted: 0 },
          { id: 2, conflicted: 2 },
        ],
        active: 2,
      },
    ]);
    expect(reveals).toEqual([false, false, true, false, false]);
    expect(memo.pending.size).toBe(0);
  });

  it('비활성인 사이 충돌이 모두 풀리면 계기도 사라진다', () => {
    const { reveals } = walk([
      { tabs: [{ id: 2, conflicted: 0 }], active: 1 },
      { tabs: [{ id: 2, conflicted: 1 }], active: 1 },
      { tabs: [{ id: 2, conflicted: 0 }], active: 1 },
      { tabs: [{ id: 2, conflicted: 0 }], active: 2 },
    ]);
    expect(reveals).toEqual([false, false, false, false]);
  });

  it('폴더 탭이 활성이면(저장소 탭 목록에 없는 id) 열지 않고, 저장소 탭으로 오면 연다', () => {
    const folder = 9;
    const { reveals } = walk([
      { tabs: [{ id: 2, conflicted: 3 }], active: folder },
      { tabs: [{ id: 2, conflicted: 3 }], active: null },
      { tabs: [{ id: 2, conflicted: 3 }], active: 2 },
    ]);
    expect(reveals).toEqual([false, false, true]);
  });

  it('닫힌 탭의 기억은 버린다 — 같은 id 로 다시 열리면 처음 보는 탭이다', () => {
    const { reveals, memo } = walk([
      { tabs: [{ id: 1, conflicted: 1 }], active: 1 },
      { tabs: [], active: null },
    ]);
    expect(reveals).toEqual([true, false]);
    expect(memo.seen.size).toBe(0);
    expect(walk([{ tabs: [{ id: 1, conflicted: 1 }], active: 1 }], memo).reveals).toEqual([true]);
  });
});
