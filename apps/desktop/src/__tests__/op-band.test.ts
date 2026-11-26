import type { RepoChanges, RepoSummary, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { withRepoExpanded } from '../features/commit/commit-tree-model';
import {
  abortConfirm,
  conflictPaths,
  conflictPathsOf,
  conflictResolveTarget,
  conflictResolveTitle,
  ISOLATED_ROW_COLUMNS,
  isolatedDiscardConfirm,
  isolatedRow,
  OP_BAND_MAX_ROWS,
  OP_ROW_SLOTS,
  type OpBandSession,
  opBandOverflow,
  opBandRows,
  opControls,
  opRowSlots,
  opRunResult,
  opSlotColumn,
  repoOpRow,
} from '../features/workspace/op-band';

/** 요약 한 줄 */
function summary(name: string, over: Partial<RepoSummary> = {}): RepoSummary {
  return {
    path: `/f/${name}`,
    name,
    kind: 'standalone',
    color: 3,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
    ...over,
  };
}

/** 세션 상태 (띠가 읽는 것) */
function session(over: Partial<OpBandSession> = {}): OpBandSession {
  return { op: null, conflicted: 0, busy: false, kept: 0, pinned: false, ...over };
}

const REBASE = {
  kind: 'rebase' as const,
  interactive: false,
  headName: 'refs/heads/x',
  onto: 'o',
  step: 1,
  total: 5,
};

describe('작업 진행 띠의 줄 (WS-10)', () => {
  it('요약에 작업이 있는 저장소만 줄이 된다. 세션이 없으면 요약이 아는 만큼(REBASING, 충돌 수)', () => {
    const rows = opBandRows(
      [summary('api'), summary('catalog', { op: 'rebase', conflicted: 2 }), summary('web')],
      {},
    );
    expect(rows).toEqual([
      {
        repoPath: '/f/catalog',
        repoName: 'catalog',
        color: 3,
        kind: 'rebase',
        label: S.project.rebasing,
        conflicts: 2,
        busy: false,
        kept: 0,
        error: null,
      },
    ]);
  });

  it('세션이 있으면 세션을 믿는다: 단계·충돌 수·도는 쓰기. 세션이 작업 없음이면 요약이 늦어도 줄이 빠진다', () => {
    const summaries = [
      summary('catalog', { op: 'rebase', conflicted: 2 }),
      summary('billing', { op: 'merge', conflicted: 1 }),
      summary('design'),
    ];
    const rows = opBandRows(summaries, {
      '/f/catalog': session({ op: REBASE, conflicted: 0, busy: true, kept: 1 }),
      '/f/billing': session({ op: null }),
      // 요약이 아직 모르는 작업도 세션이 알면 줄이 된다
      '/f/design': session({ op: { kind: 'cherryPick', head: 'h', sequencer: false } }),
    });
    expect(rows.map((r) => [r.repoName, r.label, r.conflicts, r.busy, r.kept])).toEqual([
      ['catalog', S.status.op.rebase(2, 5), 0, true, 1],
      ['design', S.status.op.cherryPick, 0, false, 0],
    ]);
  });

  it('요약을 못 읽은 저장소는 세션이 진행 중이라고 알 때만 줄이 있고, 사유를 싣는다', () => {
    const failed = summary('infra', { error: 'git status 실패' });
    expect(opBandRows([failed], {})).toEqual([]);
    expect(opBandRows([failed], { '/f/infra': session({ op: REBASE }) })[0]?.error).toBe(
      'git status 실패',
    );
  });

  it('줄 수 상한: 3줄까지 보이고 나머지는 스크롤로 가려진다', () => {
    expect(OP_BAND_MAX_ROWS).toBe(3);
    expect(opBandOverflow(1)).toEqual({ visible: 1, hidden: 0 });
    expect(opBandOverflow(3)).toEqual({ visible: 3, hidden: 0 });
    expect(opBandOverflow(5)).toEqual({ visible: 3, hidden: 2 });
  });
});

describe('버튼 조건과 확인창 (저장소 탭 배너와 공용)', () => {
  it('Skip 은 rebase·cherry-pick·revert 에만. Continue 는 충돌이 남거나 쓰기가 돌면 꺼지고, 충돌이면 사유가 있다', () => {
    expect(opControls('rebase', 0, false)).toEqual({
      canSkip: true,
      continueDisabled: false,
      continueReason: null,
      hint: S.op.noConflicts,
    });
    expect(opControls('merge', 2, false)).toEqual({
      canSkip: false,
      continueDisabled: true,
      continueReason: S.opBand.continueBlocked(2),
      hint: S.op.conflicts(2),
    });
    expect(opControls('cherryPick', 0, true).continueDisabled).toBe(true);
    expect(opControls('revert', 0, true).continueReason).toBeNull();
    expect(opControls('bisect', 0, false).canSkip).toBe(false);
  });

  it('중단 확인창: 저장소 탭은 지금 문구 그대로, 띠는 저장소 이름·작업 종류·잃는 것. 보관한 해결이 있으면 함께 알린다', () => {
    expect(abortConfirm({ kind: 'rebase', kept: 0 })).toEqual({
      title: S.op.abortTitle,
      message: S.op.abortMessage,
      confirmLabel: S.op.abort,
      danger: true,
    });
    expect(abortConfirm({ kind: 'merge', kept: 2 }).message).toBe(
      `${S.op.abortMessage} ${S.op.abortKept(2)}`,
    );
    const folder = abortConfirm({ kind: 'rebase', kept: 1, repoName: 'catalog-service' });
    expect(folder.title).toBe(S.opBand.abortTitle('catalog-service', '리베이스'));
    expect(folder.title).toContain('catalog-service');
    expect(folder.message).toBe(`${S.opBand.abortMessage} ${S.op.abortKept(1)}`);
    expect(folder.danger).toBe(true);
  });
});

describe('띠의 열 배치 (W19)', () => {
  it('칸마다 정해진 열이 있다: 대상 | 라벨 | 충돌 수 | 안내 | 충돌 해결 | Continue | Skip | Abort', () => {
    expect(OP_ROW_SLOTS.map((slot) => [slot, opSlotColumn(slot)])).toEqual([
      ['subject', 1],
      ['label', 2],
      ['count', 3],
      ['hint', 4],
      ['resolve', 5],
      ['continue', 6],
      ['skip', 7],
      ['abort', 8],
    ]);
  });

  it('그 줄에 그릴 칸: merge 는 Skip 이 없고, 충돌이 없거나 충돌 해결 동작이 없으면 충돌 수·충돌 해결이 없다', () => {
    const base = { conflicts: 2, subject: true, resolvable: true };
    expect(opRowSlots({ ...base, kind: 'rebase' })).toEqual([...OP_ROW_SLOTS]);
    expect(opRowSlots({ ...base, kind: 'merge' })).toEqual([
      'subject',
      'label',
      'count',
      'hint',
      'resolve',
      'continue',
      'abort',
    ]);
    expect(opRowSlots({ ...base, kind: 'cherryPick', conflicts: 0 })).toEqual([
      'subject',
      'label',
      'hint',
      'continue',
      'skip',
      'abort',
    ]);
    // 저장소 탭의 한 줄 배너: 대상·충돌 해결 동작이 없다 (지금 모양 그대로)
    expect(opRowSlots({ kind: 'merge', conflicts: 1, subject: false, resolvable: false })).toEqual([
      'label',
      'hint',
      'continue',
      'abort',
    ]);
  });
});

describe('저장소 탭 띠의 줄 (W21)', () => {
  it('작업 줄: 세션에 진행 중인 작업이 있을 때만. 라벨은 단계까지, 충돌 수·도는 쓰기·보관한 해결은 세션 값', () => {
    expect(repoOpRow({ op: null, conflicted: 0, busy: false, kept: 0 })).toBeNull();
    expect(repoOpRow({ op: REBASE, conflicted: 2, busy: true, kept: 1 })).toEqual({
      kind: 'rebase',
      label: S.status.op.rebase(2, 5),
      conflicts: 2,
      busy: true,
      kept: 1,
    });
    expect(
      repoOpRow({ op: { kind: 'merge', head: 'x' }, conflicted: 0, busy: false, kept: 0 })?.label,
    ).toBe(S.status.op.merge);
  });

  it('격리 줄: 격리 워크트리 탭일 때만. 쓰기 중·진행 중 작업·남은 변경(staged·unstaged·untracked·충돌)이면 반영을 막고 사유', () => {
    const clean = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    const base = { isolatedBranch: 'mgit/isolated-1', busy: false, op: null, summary: clean };
    expect(isolatedRow({ ...base, isolatedBranch: null })).toBeNull();
    expect(isolatedRow(base)).toEqual({ branch: 'mgit/isolated-1', applyBlocked: null });
    const blocked = [
      { ...base, busy: true },
      { ...base, op: { kind: 'merge' as const, head: 'x' } },
      ...(['staged', 'unstaged', 'untracked', 'conflicted'] as const).map((k) => ({
        ...base,
        summary: { ...clean, [k]: 1 },
      })),
    ];
    for (const input of blocked) {
      expect(isolatedRow(input)?.applyBlocked).toBe(S.preview.isolatedApplyBlocked);
    }
  });

  it('격리 "버리기" 확인창은 옛 사이드바 문구 그대로(위험). 반영은 Continue 열, 버리기는 Abort 열에 놓인다', () => {
    expect(isolatedDiscardConfirm()).toEqual({
      title: S.preview.isolatedTitle,
      message: S.preview.isolatedDiscardConfirm,
      confirmLabel: S.preview.isolatedDiscard,
      danger: true,
    });
    expect(ISOLATED_ROW_COLUMNS).toEqual({
      label: 'label',
      hint: 'hint',
      apply: 'continue',
      discard: 'abort',
    });
  });
});

describe('실행 결과 분류', () => {
  const base = { actionError: null, pendingHint: null, lastOutcome: null } as const;

  it('힌트 > 오류 > 다시 충돌 > 끝남', () => {
    expect(opRunResult(base)).toEqual({ kind: 'done' });
    expect(opRunResult({ ...base, lastOutcome: 'clean' })).toEqual({ kind: 'done' });
    expect(opRunResult({ ...base, lastOutcome: 'conflicts' })).toEqual({ kind: 'conflicts' });
    expect(opRunResult({ ...base, actionError: '실패' })).toEqual({
      kind: 'failed',
      message: '실패',
    });
    expect(
      opRunResult({ ...base, actionError: '실패', pendingHint: { kind: 'indexLock' } }),
    ).toEqual({ kind: 'hint' });
  });
});

describe('충돌 해결 진입', () => {
  it('폴더 변경 목록에서 그 저장소의 충돌 파일만', () => {
    const changes = [
      {
        path: '/f/catalog',
        name: 'catalog',
        branch: null,
        summary: {} as RepoChanges['summary'],
        entries: [
          {
            path: 'a.kt',
            origPath: null,
            index: 'unmerged',
            worktree: 'unmerged',
            submodule: null,
            conflict: 'bothModified',
            renameScore: null,
          },
          {
            path: 'b.kt',
            origPath: null,
            index: 'modified',
            worktree: 'unmodified',
            submodule: null,
            conflict: null,
            renameScore: null,
          },
        ],
      },
    ] as RepoChanges[];
    expect(conflictPathsOf(changes, '/f/catalog')).toEqual(['a.kt']);
    expect(conflictPathsOf(changes, '/f/other')).toEqual([]);
  });

  it('세션 상태 목록에서 충돌 파일만 (저장소 탭). 하나면 그 파일의 충돌 탭, 여럿이거나 아직 모르면 Commit 도구 창 (W21)', () => {
    const entry = (path: string, conflict: StatusEntry['conflict']): StatusEntry => ({
      path,
      origPath: null,
      index: conflict ? 'unmerged' : 'modified',
      worktree: conflict ? 'unmerged' : 'unmodified',
      submodule: null,
      conflict,
      renameScore: null,
    });
    const one = [entry('a.kt', 'bothModified'), entry('b.kt', null)];
    expect(conflictPaths(one)).toEqual(['a.kt']);
    expect(conflictResolveTarget(conflictPaths(one))).toEqual({ kind: 'file', path: 'a.kt' });
    expect(conflictResolveTitle({ kind: 'file', path: 'a.kt' }, 1)).toBe(S.opBand.resolveOne);
    const two = [...one, entry('c.kt', 'deletedByThem')];
    expect(conflictResolveTarget(conflictPaths(two))).toEqual({ kind: 'list' });
    expect(conflictResolveTitle({ kind: 'list' }, 2)).toBe(S.opBand.resolveMany(2));
    // 상태를 아직 읽지 못했으면(충돌 수만 알고 목록이 비었으면) 목록으로
    expect(conflictResolveTarget([])).toEqual({ kind: 'list' });
  });

  it('Commit 도구 창에서 그 저장소와 그 아래 디렉터리만 펼친다', () => {
    const collapsed = ['r:/f/a', 'd:/f/a\u0000src', 'd:/f/a\u0000src/x', 'r:/f/b', 'd:/f/b\u0000y'];
    expect(withRepoExpanded(collapsed, '/f/a')).toEqual(['r:/f/b', 'd:/f/b\u0000y']);
    // 이름이 겹치는 다른 저장소(/f/ab)는 건드리지 않는다
    expect(withRepoExpanded(['r:/f/ab', 'd:/f/ab\u0000z'], '/f/a')).toEqual([
      'r:/f/ab',
      'd:/f/ab\u0000z',
    ]);
  });
});
