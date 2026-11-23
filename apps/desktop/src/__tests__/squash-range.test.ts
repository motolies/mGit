// 로그 범위를 하나로 합치기 (MRG-07, GRAPH-10): 메뉴의 켜짐 조건, plan·검사·초안 순수 함수, 스토어의 준비·실행 흐름.
// git 결과(메시지·트리·Undo)는 코어 통합 테스트(`crates/mgit-core/tests/rebase_plan.rs` 의 `squash_range_*`)가 본다.

import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type GraphRow,
  type IpcClient,
  type PlanCommit,
  type RepoOpened,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import { graphMenuItems } from '../features/graph/graph-menu';
import type { RangeSelection } from '../store';
import { createSessionStore } from '../store/session-store';
import {
  buildSquashRangePlan,
  checkSquashRange,
  EMPTY_TREE,
  rangeRowCount,
  squashRangeDraft,
  squashRangeOnto,
} from '../store/squash-range';
import { tick } from './dialog-stub';

const P = 'f'.repeat(40);
const [A, B, C, D, N] = ['a', 'b', 'c', 'd', 'e'].map((x) => x.repeat(40)) as [
  string,
  string,
  string,
  string,
  string,
];
/** plan 목록 한 줄 */
const pc = (oid: string, subject: string): PlanCommit => ({ oid, subject, authorName: 'me' });
/** `P..HEAD` = A, B, C, D (오래된 것부터) */
const COMMITS = [pc(A, 'A'), pc(B, 'B'), pc(C, 'C'), pc(D, 'D')];
/** 로그 행 1~3 을 칠한 범위 A..C (행 번호가 작을수록 최신) */
const RANGE: RangeSelection = {
  from: 1,
  to: 3,
  newer: C,
  older: A,
  base: P,
  files: [],
  loading: false,
};

describe('범위 합치기 순수 함수', () => {
  it('기준은 범위 diff 의 기준(older^)이고, 빈 트리(첫 commit 이 든 범위)면 --root(null)다', () => {
    expect(squashRangeOnto(P)).toBe(P);
    expect(squashRangeOnto(EMPTY_TREE)).toBeNull();
    expect(rangeRowCount(RANGE)).toBe(3);
  });

  it('검사: 범위와 범위 뒤를 나누고, merge·현재 branch 밖·줄 수 불일치는 사유로 막는다', () => {
    const ok = checkSquashRange({ commits: COMMITS, hasMerges: false }, P, A, C, 3);
    expect(ok).toEqual({
      ok: true,
      target: { onto: P, range: COMMITS.slice(0, 3), trailing: [COMMITS[3]] },
    });
    // merge 가 범위 안이나 위(HEAD 까지)에 있다
    expect(checkSquashRange({ commits: COMMITS, hasMerges: true }, P, A, C, 3)).toEqual({
      ok: false,
      reason: S.rebase.squashRangeMerges,
    });
    // 가장 오래된 commit 이 목록 첫째가 아니거나(현재 branch 밖) 가장 새 commit 이 목록에 없다
    for (const [older, newer] of [
      [B, C],
      [A, N],
    ] as const) {
      expect(checkSquashRange({ commits: COMMITS, hasMerges: false }, P, older, newer, 2)).toEqual({
        ok: false,
        reason: S.rebase.squashRangeNotOnBranch,
      });
    }
    // 칠한 줄 수와 이어진 commit 수가 다르다 (다른 branch 의 줄이 끼었거나 필터로 가림)
    expect(checkSquashRange({ commits: COMMITS, hasMerges: false }, P, A, C, 4)).toEqual({
      ok: false,
      reason: S.rebase.squashRangeMixed,
    });
  });

  it('초안: 메시지를 오래된 것부터 빈 줄 하나로 잇고 끝 공백은 걷는다', () => {
    expect(squashRangeDraft(['A\n\nbody of A\n', 'B\n', '', 'C'])).toBe('A\n\nbody of A\n\nB\n\nC');
  });

  it('plan: 가장 오래된 commit 은 reword(사용자 메시지), 나머지는 fixup, 범위 뒤는 pick', () => {
    const plan = buildSquashRangePlan(
      { onto: P, range: COMMITS.slice(0, 3), trailing: [COMMITS[3] as PlanCommit] },
      'one\n\nbody',
    );
    expect(plan).toEqual({
      onto: P,
      steps: [
        { oid: A, action: { kind: 'reword', message: 'one\n\nbody' } },
        { oid: B, action: { kind: 'fixup' } },
        { oid: C, action: { kind: 'fixup' } },
        { oid: D, action: { kind: 'pick' } },
      ],
      autostash: true,
      updateRefs: false,
      exec: null,
    });
    // 첫 commit 이 든 범위는 --root
    expect(buildSquashRangePlan({ onto: null, range: [], trailing: [] }, 'x').onto).toBeNull();
  });
});

describe('범위 합치기 메뉴', () => {
  const row = {
    row: 2,
    oid: B,
    parents: [A],
    refs: [],
    subject: 'B',
    inHead: true,
  } as unknown as GraphRow;
  const dialogs = {
    prompt: vi.fn(async () => null),
    confirm: async () => false,
    confirmChoice: async () => 'cancel' as const,
  };

  /** 메뉴 동작 스파이 */
  function actions(over: Record<string, unknown> = {}) {
    return {
      busy: false,
      op: null,
      headBranch: 'main',
      selectedCommit: A,
      signingInfo: null,
      range: RANGE,
      prepareSquashRange: vi.fn(async () => null),
      squashRange: vi.fn(async () => true),
      ...over,
    } as never;
  }
  const label = S.menu.squashRange(3);
  const find = (list: ReturnType<typeof graphMenuItems>) => list.find((i) => i.label === label);

  it('범위 안의 행에서만 보이고, 메시지 수정과 같은 조건에서 켜진다 (N = 칠한 줄 수)', () => {
    expect(find(graphMenuItems(row, actions(), dialogs))?.disabled).toBe(false);
    // 범위가 없거나 범위 밖 행이면 항목이 없다
    expect(find(graphMenuItems(row, actions({ range: null }), dialogs))).toBeUndefined();
    expect(find(graphMenuItems({ ...row, row: 4 }, actions(), dialogs))).toBeUndefined();
    // 바쁨·진행 중 작업·분리된 HEAD·HEAD 에서 닿지 않음·범위 diff 읽는 중·merge 행이면 꺼진다
    for (const [r, over] of [
      [row, { busy: true }],
      [row, { op: { kind: 'rebase' } }],
      [row, { headBranch: null }],
      [{ ...row, inHead: false }, {}],
      [row, { range: { ...RANGE, loading: true } }],
      [{ ...row, parents: [A, P] }, {}],
    ] as const) {
      expect(find(graphMenuItems(r as GraphRow, actions(over), dialogs))?.disabled).toBe(true);
    }
  });

  it('고르면 초안을 채운 메시지 하나를 받아 그 메시지로 합친다. 준비가 막히면 대화상자를 열지 않는다', async () => {
    const prep = {
      onto: P,
      range: COMMITS.slice(0, 3),
      trailing: [COMMITS[3] as PlanCommit],
      draft: 'A\n\nB\n\nC',
    };
    const prompt = vi.fn(async () => ({ message: 'one' }));
    const a = actions({ prepareSquashRange: vi.fn(async () => prep) });
    find(graphMenuItems(row, a, { ...dialogs, prompt }))?.onSelect?.();
    await tick();
    expect(prompt.mock.calls[0]?.[0 as never]).toMatchObject({
      title: S.rebase.squashRangeTitle(3),
      confirmLabel: S.rebase.squashRangeRun,
      fields: [{ key: 'message', type: 'textarea', initial: 'A\n\nB\n\nC', required: true }],
    });
    expect((a as { squashRange: ReturnType<typeof vi.fn> }).squashRange).toHaveBeenCalledWith(
      prep,
      'one',
    );

    const blocked = vi.fn(async () => null);
    find(graphMenuItems(row, actions(), { ...dialogs, prompt: blocked }))?.onSelect?.();
    await tick();
    expect(blocked).not.toHaveBeenCalled();
  });
});

describe('SessionStore 범위 합치기', () => {
  /** plan 목록·메시지·rebase 를 흉내 내는 클라이언트. 실행 뒤 목록은 합친 commit N 과 D */
  function setup(over: Partial<IpcClient> = {}) {
    let rebased = false;
    const c: IpcClient = {
      ...createNullClient(),
      rebasePlanCommits: vi.fn(async () =>
        rebased
          ? { commits: [pc(N, 'one'), pc(D, 'D')], hasMerges: false }
          : { commits: COMMITS, hasMerges: false },
      ),
      commitMessage: vi.fn(async (_s: number, oid: string) => `${oid.slice(0, 1)}\n`),
      rebaseInteractive: vi.fn(async () => {
        rebased = true;
        return 'clean' as const;
      }),
      ...over,
    };
    const head = { state: 'attached' as const, branch: 'main', oid: D };
    const opened: RepoOpened = {
      session: 1,
      alreadyOpen: false,
      nestedRepos: [],
      superproject: null,
      info: {
        workTree: '/r',
        gitDir: '/r/.git',
        commonDir: '/r/.git',
        objectFormat: 'sha1',
        head,
        commitGraph: { present: false },
        shallow: false,
      },
      state: emptyRepoState(head),
    };
    const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
    const store = createSessionStore(opened, c, cache);
    store.setState({ range: RANGE, selectedCommit: A });
    return { store, client: c };
  }

  it('준비: 기준에서 HEAD 까지를 검사하고 범위 메시지로 초안을 만든다. 첫 commit 이 든 범위는 --root 로 읽는다', async () => {
    const { store, client: c } = setup();
    const prep = await store.getState().prepareSquashRange();
    expect(c.rebasePlanCommits).toHaveBeenCalledWith(1, P);
    expect(c.commitMessage).toHaveBeenCalledTimes(3);
    expect(prep).toEqual({
      onto: P,
      range: COMMITS.slice(0, 3),
      trailing: [COMMITS[3]],
      draft: 'a\n\nb\n\nc',
    });

    store.setState({ range: { ...RANGE, base: EMPTY_TREE } });
    await store.getState().prepareSquashRange();
    expect(c.rebasePlanCommits).toHaveBeenLastCalledWith(1, null);
  });

  it('준비가 막히면 사유를 오류 줄에 두고 null. 범위 diff 를 읽는 중이면 묻지 않는다', async () => {
    const { store, client: c } = setup({
      rebasePlanCommits: vi.fn(async () => ({ commits: COMMITS, hasMerges: true })),
    });
    expect(await store.getState().prepareSquashRange()).toBeNull();
    expect(store.getState().actionError).toBe(S.rebase.squashRangeMerges);
    expect(c.commitMessage).not.toHaveBeenCalled();

    store.setState({ range: { ...RANGE, loading: true }, actionError: null });
    expect(await store.getState().prepareSquashRange()).toBeNull();
    expect(c.rebasePlanCommits).toHaveBeenCalledTimes(1);
  });

  it('실행: 기존 rebase 경로로 plan 을 넘기고 범위를 푼 뒤 새 commit 으로 이동을 건다', async () => {
    const { store, client: c } = setup();
    const prep = await store.getState().prepareSquashRange();
    expect(prep).not.toBeNull();
    expect(await store.getState().squashRange(prep as never, 'one')).toBe(true);
    expect(c.rebaseInteractive).toHaveBeenCalledWith(1, buildSquashRangePlan(prep as never, 'one'));
    expect(store.getState().range).toBeNull();
    expect(store.getState().lastOutcome).toBe('clean');
    // 그래프 재로드가 아직이라 새 commit 을 못 찾았다: 재로드가 끝나면 그리로 간다
    expect(store.getState().pendingJump).toBe(N);
  });

  it('충돌로 멈추면 범위만 풀고 진행 띠(lastOutcome)에 맡긴다. 실패하면 범위를 남긴다', async () => {
    const stopped = setup({ rebaseInteractive: vi.fn(async () => 'conflicts' as const) });
    const prep = (await stopped.store.getState().prepareSquashRange()) as never;
    expect(await stopped.store.getState().squashRange(prep, 'one')).toBe(true);
    expect(stopped.store.getState().lastOutcome).toBe('conflicts');
    expect(stopped.store.getState().range).toBeNull();
    expect(stopped.store.getState().pendingJump).toBeNull();

    const failed = setup({
      rebaseInteractive: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const prep2 = (await failed.store.getState().prepareSquashRange()) as never;
    expect(await failed.store.getState().squashRange(prep2, 'one')).toBe(false);
    expect(failed.store.getState().range).toEqual(RANGE);
    expect(failed.store.getState().actionError).not.toBeNull();
  });
});
