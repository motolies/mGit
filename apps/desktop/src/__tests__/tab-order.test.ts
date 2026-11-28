import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../store/app-store';
import { groupTabOrder, tabParentPaths, tabRoot, tabSets } from '../store/tab-order';

/** 탭 메타 하나를 만든다 */
function tab(id: number, path: string, parent: number | null = null): SessionMeta {
  return { id, kind: parent === null ? 'folder' : 'repo', path, name: path, parent };
}

/** 탭 목록을 id 로 찾는 맵으로 바꾼다 */
function sessionsOf(...tabs: SessionMeta[]): Record<number, SessionMeta> {
  return Object.fromEntries(tabs.map((t) => [t.id, t]));
}

describe('탭 세트 순서 (tab-order)', () => {
  it('폴더 F → 독립 R → F 의 자식 C 순서로 열면 [F, C, R] 이다', () => {
    const sessions = sessionsOf(tab(1, '/f'), tab(2, '/r'), tab(3, '/f/a', 1));
    expect(groupTabOrder([1, 2, 3], sessions)).toEqual([1, 3, 2]);
    expect(tabSets([1, 3, 2], sessions)).toEqual([
      { root: 1, ids: [1, 3] },
      { root: 2, ids: [2] },
    ]);
  });

  it('손자도 같은 세트에 묶이고, 부모가 자식보다 앞에 온다', () => {
    const sessions = sessionsOf(tab(1, '/f'), tab(2, '/r'), tab(3, '/f/a', 1), tab(4, '/wt', 3));
    expect(tabRoot(4, sessions)).toBe(1);
    expect(groupTabOrder([1, 2, 3, 4], sessions)).toEqual([1, 3, 4, 2]);
    // 기존 순서에서 손자가 부모보다 앞이어도 부모를 먼저 둔다
    expect(groupTabOrder([4, 2, 3, 1], sessions)).toEqual([1, 3, 4, 2]);
  });

  it('부모가 닫힌 고아는 단독 탭이 된다', () => {
    const sessions = sessionsOf(tab(2, '/r'), tab(3, '/f/a', 1));
    expect(tabRoot(3, sessions)).toBe(3);
    expect(tabSets([2, 3], sessions)).toEqual([
      { root: 2, ids: [2] },
      { root: 3, ids: [3] },
    ]);
  });

  it('중간 부모가 닫히면 그 아래는 새 세트가 되고 남은 세트는 다시 붙는다', () => {
    // F 아래 C1·C2, C1 아래 W1, C2 아래 W2 에서 C1 을 닫았다
    const sessions = sessionsOf(
      tab(1, '/f'),
      tab(3, '/f/b', 1),
      tab(4, '/w1', 2),
      tab(5, '/w2', 3),
    );
    expect(groupTabOrder([1, 3, 4, 5], sessions)).toEqual([1, 3, 5, 4]);
  });

  it('부모 관계가 순환해도 멈추고 각자 단독 탭이 된다', () => {
    const sessions = sessionsOf(tab(1, '/a', 2), tab(2, '/b', 1), tab(3, '/c', 1));
    expect(tabRoot(1, sessions)).toBe(1);
    expect(tabRoot(2, sessions)).toBe(2);
    expect(tabRoot(3, sessions)).toBe(3);
    expect(groupTabOrder([1, 2, 3], sessions)).toEqual([1, 2, 3]);
    expect(tabSets([1, 2, 3], sessions).map((s) => s.ids)).toEqual([[1], [2], [3]]);
  });

  it('세션이 없는 id 는 순서에 남기되 화면 묶음에서는 건너뛴다', () => {
    const sessions = sessionsOf(tab(1, '/f'));
    expect(groupTabOrder([1, 9], sessions)).toEqual([1, 9]);
    expect(tabSets([1, 9], sessions)).toEqual([{ root: 1, ids: [1] }]);
  });

  it('저장할 부모 경로 맵은 부모가 열린 탭만 담는다', () => {
    const sessions = sessionsOf(
      tab(1, '/f'),
      tab(3, '/f/a', 1),
      tab(4, '/wt', 3),
      tab(5, '/orphan', 8),
    );
    expect(tabParentPaths([1, 3, 4, 5], sessions)).toEqual({ '/f/a': '/f', '/wt': '/f/a' });
  });
});
