import { describe, expect, it } from 'vitest';
import {
  BRANCHES_MIN_TOOLWINDOW_WIDTH,
  branchesCollapsed,
  GIT_LOG_SPLIT,
  isTooNarrowForBranches,
} from '../features/folder/FolderTimeline';
import {
  isSideCollapsed,
  type SideSplit,
  sidePercentOf,
  sideSplitLayout,
} from '../layout/use-side-split';
import { WORKSPACE_SPLIT } from '../layout/WorkspaceShell';

const SPLIT: SideSplit = { layoutId: 't', sideId: 'side', mainId: 'main', defaultPercent: 20 };

describe('한쪽 칸을 접는 두 칸 분할', () => {
  it('펼친 배치는 기억한 크기를, 접힌 배치는 0 을 쓴다', () => {
    expect(sideSplitLayout(SPLIT, false, 27.337)).toEqual({ side: 27.337, main: 72.663 });
    expect(sideSplitLayout(SPLIT, true, 27.337)).toEqual({ side: 0, main: 100 });
  });

  it('접힌 배치인지 판정한다 (패널이 없는 배치는 접힌 것으로 본다)', () => {
    expect(isSideCollapsed(SPLIT, { side: 0, main: 100 })).toBe(true);
    expect(isSideCollapsed(SPLIT, { side: 14.2, main: 85.8 })).toBe(false);
    expect(isSideCollapsed(SPLIT, {})).toBe(true);
  });

  it.each([false, true])(
    '배치를 만들고 다시 판정하면 같은 접힘 여부가 나온다 (접힘 %s)',
    (collapsed) => {
      expect(isSideCollapsed(SPLIT, sideSplitLayout(SPLIT, collapsed, 33))).toBe(collapsed);
    },
  );

  it('펼친 상태의 크기만 기억한다: 접힌 값·없는 값·다른 id 는 기본 크기다', () => {
    expect(sidePercentOf(SPLIT, { side: 27.337, main: 72.663 })).toBe(27.337);
    expect(sidePercentOf(SPLIT, { side: 0, main: 100 })).toBe(20);
    expect(sidePercentOf(SPLIT, { side: 100, main: 0 })).toBe(20);
    expect(sidePercentOf(SPLIT, undefined)).toBe(20);
    expect(sidePercentOf(SPLIT, { left: 30, right: 70 })).toBe(20);
  });

  it('위 영역과 로그 탭의 분할은 서로 다른 저장 id·패널 id 를 쓰고 기본 크기는 20% 다', () => {
    expect(WORKSPACE_SPLIT).toEqual({
      layoutId: 'workspace',
      sideId: 'ws-left',
      mainId: 'ws-editor',
      defaultPercent: 20,
    });
    expect(GIT_LOG_SPLIT).toEqual({
      layoutId: 'git-log',
      sideId: 'gitlog-branches',
      mainId: 'gitlog-commits',
      defaultPercent: 20,
    });
  });
});

describe('브랜치 목록 자동 접힘 (WS-06)', () => {
  it('Git 도구 창이 760px 보다 좁으면 접는다 (경계는 포함하지 않는다)', () => {
    expect(BRANCHES_MIN_TOOLWINDOW_WIDTH).toBe(760);
    expect(isTooNarrowForBranches(759)).toBe(true);
    expect(isTooNarrowForBranches(760)).toBe(false);
    expect(isTooNarrowForBranches(924)).toBe(false);
  });

  it('아직 재지 못한 폭(0)으로는 접지 않는다', () => {
    expect(isTooNarrowForBranches(0)).toBe(false);
    expect(branchesCollapsed(true, 0)).toBe(false);
  });

  it.each<[boolean, number, boolean]>([
    [true, 924, false],
    [true, 744, true],
    [false, 924, true],
    [false, 744, true],
  ])('펼쳐 둠 %s, 폭 %i → 접힘 %s', (open, width, collapsed) => {
    expect(branchesCollapsed(open, width)).toBe(collapsed);
  });

  it('자동 접힘은 사용자의 선택을 바꾸지 않는다: 폭이 돌아오면 펼쳐 둔 목록만 다시 펴진다', () => {
    const widths = [924, 744, 924];
    expect(widths.map((w) => branchesCollapsed(true, w))).toEqual([false, true, false]);
    expect(widths.map((w) => branchesCollapsed(false, w))).toEqual([true, true, true]);
  });
});
