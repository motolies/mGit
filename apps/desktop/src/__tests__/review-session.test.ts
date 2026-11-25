import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type PushSpec,
  type RepoOpened,
  type StashEntry,
} from '@mgit/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyHub } from '../store/notify';
import { createSessionStore, type SessionState } from '../store/session-store';
import { documentOf } from './diff-document-fixture';

const HEAD = 'a'.repeat(40);

/** 스태시 항목 */
function stash(index: number, ch: string, message: string): StashEntry {
  return {
    info: {
      index,
      oid: ch.repeat(40),
      base: HEAD,
      message,
      time: 1,
      includesUntracked: false,
      branch: 'main',
    },
    origin: null,
  };
}

/** 스토어 하나 */
function setup(over: Partial<IpcClient> = {}) {
  const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
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
  const client: IpcClient = { ...createNullClient(), ...over };
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, client, cache), client };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const notes: { title: string; message?: string }[] = [];
beforeEach(() => {
  notes.length = 0;
  notifyHub.setHandler((n) => notes.push(n));
});

/** 현재 상태에 충돌 항목만 바꾼 statusChanged */
function statusEvent(s: SessionState, paths: string[]) {
  return {
    type: 'statusChanged' as const,
    session: 1,
    status: {
      ...s.status,
      entries: paths.map((path) => ({
        path,
        index: 'unmerged',
        worktree: 'unmerged',
        conflict: true,
      })),
    } as unknown as SessionState['status'],
    op: null,
  };
}

describe('스태시는 위치가 아니라 oid 로 다룬다', () => {
  it('목록이 바뀌면 보고 있는 스태시의 번호도 따라간다', async () => {
    let list = [stash(0, '1', 'A'), stash(1, '2', 'B'), stash(2, '3', 'C')];
    const { store } = setup({ listStashes: async () => list, stashFiles: async () => [] });
    await store.getState().selectStash(list[1] as StashEntry);
    list = [stash(0, '2', 'B'), stash(1, '3', 'C')];
    await store.getState().loadStashes();
    expect(store.getState().stashView?.entry.info.index).toBe(0);
    expect(store.getState().stashView?.entry.info.message).toBe('B');
  });

  it('drop·pop·apply 는 실행 직전 oid 로 번호를 다시 찾는다', async () => {
    let list = [stash(0, '1', 'A'), stash(1, '2', 'B')];
    const stashDrop = vi.fn(async () => {});
    const stashPop = vi.fn(async () => {});
    const stashApply = vi.fn(async () => {});
    const { store } = setup({ listStashes: async () => list, stashDrop, stashPop, stashApply });
    list = [stash(0, '9', 'NEW'), stash(1, '1', 'A'), stash(2, '2', 'B')];
    expect(await store.getState().stashDrop('2'.repeat(40))).toBe(true);
    expect(stashDrop).toHaveBeenCalledWith(1, 2);
    await store.getState().stashPop('1'.repeat(40));
    expect(stashPop).toHaveBeenCalledWith(1, 1);
    await store.getState().stashApply('9'.repeat(40));
    expect(stashApply).toHaveBeenCalledWith(1, 0);
  });

  it('이미 사라진 스태시는 다른 것을 건드리지 않고 알린다', async () => {
    const stashDrop = vi.fn(async () => {});
    const { store } = setup({ listStashes: async () => [stash(0, '1', 'A')], stashDrop });
    expect(await store.getState().stashDrop('2'.repeat(40))).toBe(false);
    expect(stashDrop).not.toHaveBeenCalled();
    expect(store.getState().actionError).toBeTruthy();
  });
});

describe('범위 diff', () => {
  it('무관한 상태 이벤트가 와도 닫히지 않는다', async () => {
    const { store } = setup({
      compareFileDiffDocument: async () => documentOf(),
    });
    store.setState({
      range: { from: 0, to: 1, newer: 'b', older: 'c', base: 'd', files: [], loading: false },
    });
    await store.getState().openRangeFile('r.ts');
    const s = store.getState();
    s.applyEvent({
      ...statusEvent(s, []),
      status: {
        ...s.status,
        entries: [
          {
            path: 'other.txt',
            index: 'unmodified',
            worktree: 'modified',
            conflict: false,
          } as unknown as SessionState['status']['entries'][number],
        ],
      },
    });
    expect(store.getState().selectedFile?.path).toBe('r.ts');
    // W20: 옛 가운데 화면 'diff' 단언 → diff 슬롯이 범위 diff 로 남아 있다 (보이는지는 워크스페이스가 정한다)
    expect(store.getState().selectedFile?.range?.label).toBeTruthy();
  });
});

describe('그래프 검색 응답 순서', () => {
  /** 호출마다 직접 끝낼 수 있는 검색 */
  function deferredSearch() {
    const pending: ((rows: number[]) => void)[] = [];
    const searchCommits = vi.fn(
      () =>
        new Promise<{ rows: number[]; total: number; truncated: boolean }>((resolve) => {
          pending.push((rows) => resolve({ rows, total: rows.length, truncated: false }));
        }),
    );
    return { pending, searchCommits };
  }

  it('늦게 온 옛 질의 응답이 새 결과를 덮지 않는다', async () => {
    const { pending, searchCommits } = deferredSearch();
    const { store } = setup({ searchCommits });
    const first = store.getState().runSearch('a');
    const second = store.getState().runSearch('ab');
    pending[1]?.([2]);
    await second;
    pending[0]?.([1]);
    await first;
    expect(store.getState().search.query).toBe('ab');
    expect(store.getState().search.rows).toEqual([2]);
  });

  it('닫은 뒤 도착한 응답이 검색을 다시 열지 않는다', async () => {
    const { pending, searchCommits } = deferredSearch();
    const { store } = setup({ searchCommits });
    store.getState().setSearchOpen(true);
    const run = store.getState().runSearch('abc');
    store.getState().setSearchOpen(false);
    pending[0]?.([5]);
    await run;
    expect(store.getState().search.open).toBe(false);
    expect(store.getState().scrollToRow).toBeNull();
  });
});

describe('그래프 질의 조정 이벤트', () => {
  it('코어가 좁힌 질의로 바꾸고 빠진 ref 를 알린다', () => {
    const { store } = setup();
    const query = { ...store.getState().graphQuery, revs: { kind: 'all' as const } };
    store.setState({ graphQuery: { ...query, revs: { kind: 'solo', name: 'gone' } } });
    store
      .getState()
      .applyEvent({ type: 'graphQueryAdjusted', session: 1, query, dropped: ['gone'] });
    expect(store.getState().graphQuery).toEqual(query);
    expect(notes.map((n) => `${n.title} ${n.message ?? ''}`).join()).toContain('gone');
  });
});

describe('undo·redo', () => {
  it('건너뛴 ref 를 알린다', async () => {
    const outcome = {
      entry: { id: 1, label: 'reset', refs: [], time: 0 },
      skipped: ['refs/heads/x'],
    } as unknown as Awaited<ReturnType<IpcClient['undo']>>;
    const { store } = setup({ undo: async () => outcome, redo: async () => outcome });
    await store.getState().undo();
    expect(notes.map((n) => n.message ?? n.title).join()).toContain('refs/heads/x');
    notes.length = 0;
    await store.getState().redo();
    expect(notes.map((n) => n.message ?? n.title).join()).toContain('refs/heads/x');
  });
});

describe('push 힌트는 처음 고른 대상을 보존한다', () => {
  const rejected = (hint: { kind: string }) => ({
    kind: 'gitFailed',
    args: ['push'],
    status: 1,
    stderr: 'rejected',
    hint,
  });

  it('nonFastForward·staleInfo 에 spec 이 들어 있다', async () => {
    const push = vi.fn(async (_s: number, spec: PushSpec) => {
      throw rejected({ kind: spec.forceWithLease ? 'staleInfo' : 'nonFastForward' });
    });
    const { store } = setup({ push });
    expect(await store.getState().push({ remote: 'fork' })).toBe(false);
    const hint = store.getState().pendingHint;
    expect(hint?.kind).toBe('nonFastForward');
    expect(hint && 'spec' in hint ? hint.spec?.remote : null).toBe('fork');
    await store.getState().push({ remote: 'fork', forceWithLease: true });
    const stale = store.getState().pendingHint;
    expect(stale?.kind).toBe('staleInfo');
    expect(stale && 'spec' in stale ? stale.spec?.forceWithLease : null).toBe(true);
  });

  it('submoduleUnpushed 도 강제 여부까지 spec 을 보존한다', async () => {
    const { store } = setup({
      submoduleUnpushed: async () => [{ path: 'sub', count: 1 }] as never,
    });
    store.setState({ submodules: [{ path: 'sub' }] as never });
    await store.getState().push({ remote: 'fork', forceWithLease: true });
    const hint = store.getState().pendingHint;
    expect(hint?.kind).toBe('submoduleUnpushed');
    expect(hint && 'spec' in hint ? hint.spec : null).toMatchObject({
      remote: 'fork',
      forceWithLease: true,
    });
  });

  it('pushUpstreamMismatch 를 대화상자로 보낸다', async () => {
    const push = vi.fn(async () => {
      throw { kind: 'pushUpstreamMismatch', local: 'a', remote: 'origin', upstream: 'b' };
    });
    const { store } = setup({ push });
    await store.getState().push({ remote: 'origin' });
    expect(store.getState().pendingHint).toMatchObject({
      kind: 'pushUpstreamMismatch',
      local: 'a',
      remote: 'origin',
      upstream: 'b',
      spec: { remote: 'origin' },
    });
    expect(store.getState().actionError).toBeNull();
  });

  it('pull 은 성공 여부를 돌려준다', async () => {
    const ok = setup();
    expect(await ok.store.getState().pull()).toBe(true);
    const bad = setup({
      pull: async () => {
        throw { kind: 'internal', message: 'x' };
      },
    });
    expect(await bad.store.getState().pull()).toBe(false);
  });
});

describe('충돌 마커 확인', () => {
  const markers = { kind: 'conflictMarkers', files: ['m.txt'] };

  it('commit 이 마커로 거부되면 "그래도 커밋" 으로 다시 보낼 수 있다', async () => {
    const commit = vi.fn(async (_s: number, spec: { allowConflictMarkers: boolean }) => {
      if (!spec.allowConflictMarkers) {
        throw markers;
      }
      return HEAD;
    });
    const { store } = setup({ commit: commit as unknown as IpcClient['commit'] });
    store.getState().setCommitMessage('msg');
    expect(await store.getState().commit()).toBe(false);
    const hint = store.getState().pendingHint;
    expect(hint).toMatchObject({ kind: 'conflictMarkers', files: ['m.txt'] });
    expect(store.getState().commitError).toBeNull();
    expect(await store.getState().commit({ allowConflictMarkers: true })).toBe(true);
    expect(commit.mock.lastCall?.[1].allowConflictMarkers).toBe(true);
  });

  it('continue·저장도 허용 플래그를 코어까지 넘긴다', async () => {
    const opContinue = vi.fn(async (_s: number, allow: boolean) => {
      if (!allow) {
        throw markers;
      }
      return 'clean' as const;
    });
    const resolveFile = vi.fn(async (_s: number, _p: string, _c: string, allow: boolean) => {
      if (!allow) {
        throw markers;
      }
    });
    const { store } = setup({
      opContinue,
      resolveFile,
      syntaxCompare: async () => null as never,
    });
    await store.getState().opContinue();
    expect(store.getState().pendingHint).toMatchObject({
      kind: 'conflictMarkers',
      retry: { kind: 'opContinue' },
    });
    store.getState().dismissHint();
    await store.getState().opContinue(true);
    expect(opContinue).toHaveBeenLastCalledWith(1, true);

    store.setState({ conflict: { path: 'm.txt', payload: {} as never } });
    expect(await store.getState().saveConflict('body')).toBe(false);
    expect(store.getState().pendingHint).toMatchObject({
      kind: 'conflictMarkers',
      retry: { kind: 'saveConflict', content: 'body' },
    });
    store.getState().dismissHint();
    expect(await store.getState().saveConflict('body', { allowConflictMarkers: true })).toBe(true);
    expect(resolveFile).toHaveBeenLastCalledWith(1, 'm.txt', 'body', true);
  });

  it('구문 오류 힌트를 거쳐도 마커 허용이 유지된다', async () => {
    const { store } = setup({
      syntaxCompare: async () => ({ newErrors: true, resultErrors: 1 }) as never,
    });
    store.setState({ conflict: { path: 'm.txt', payload: {} as never } });
    await store.getState().saveConflict('body', { allowConflictMarkers: true });
    expect(store.getState().pendingHint).toMatchObject({
      kind: 'syntaxErrors',
      allowConflictMarkers: true,
    });
  });
});

describe('충돌 초안', () => {
  const draft = { text: 'mine', ranges: [], key: 'k' };

  it('화면을 떠나도 남고, 다시 충돌을 열어도 남는다', async () => {
    const { store } = setup({ conflictFile: async () => ({ labels: {} }) as never });
    store.setState({ conflict: { path: 'a.txt', payload: {} as never } });
    store.getState().setConflictDraft('a.txt', draft);
    store.getState().closeConflict();
    expect(store.getState().conflictDrafts['a.txt']).toEqual(draft);
    await store.getState().openConflict('a.txt');
    expect(store.getState().conflictDrafts['a.txt']).toEqual(draft);
    store.getState().setConflictDraft('a.txt', null);
    expect(store.getState().conflictDrafts['a.txt']).toBeUndefined();
  });

  it('밖에서 해결되어 사라지면 초안을 버리고 알린다', () => {
    const { store } = setup();
    store.setState({ conflict: { path: 'a.txt', payload: {} as never } });
    store.getState().setConflictDraft('a.txt', draft);
    store.getState().applyEvent(statusEvent(store.getState(), []));
    // 충돌 슬롯이 빈다 (옛 화면은 이때 그래프로 갔다 — 저장소 탭은 문서가 사라져 그래프가 된다, W20)
    expect(store.getState().conflict).toBeNull();
    expect(store.getState().conflictDrafts).toEqual({});
    expect(notes.length).toBe(1);
  });

  it('직접 저장해서 사라진 경우에는 알리지 않는다', async () => {
    let finish: () => void = () => {};
    const { store } = setup({
      syntaxCompare: async () => null as never,
      resolveFile: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    store.setState({ conflict: { path: 'a.txt', payload: {} as never } });
    store.getState().setConflictDraft('a.txt', draft);
    const saving = store.getState().saveConflict('body');
    await flush();
    store.getState().applyEvent(statusEvent(store.getState(), []));
    finish();
    await saving;
    expect(store.getState().conflictDrafts).toEqual({});
    expect(notes).toEqual([]);
  });

  it('저장이 실패하면 초안을 지우지 않는다', async () => {
    const { store } = setup({
      syntaxCompare: async () => null as never,
      resolveFile: async () => {
        throw { kind: 'internal', message: 'x' };
      },
    });
    store.setState({ conflict: { path: 'a.txt', payload: {} as never } });
    store.getState().setConflictDraft('a.txt', draft);
    expect(await store.getState().saveConflict('body')).toBe(false);
    expect(store.getState().conflictDrafts['a.txt']).toEqual(draft);
  });
});

describe('커밋 메시지 읽기', () => {
  it('전체 메시지를 돌려주고, 실패하면 null 과 오류를 남긴다', async () => {
    const ok = setup({ commitMessage: async () => 'subject\n\nbody' });
    expect(await ok.store.getState().commitMessageOf(HEAD)).toBe('subject\n\nbody');
    const bad = setup({
      commitMessage: async () => {
        throw { kind: 'internal', message: '없음' };
      },
    });
    expect(await bad.store.getState().commitMessageOf(HEAD)).toBeNull();
    expect(bad.store.getState().actionError).toContain('없음');
  });
});

describe('폐기 백업', () => {
  const rec = { id: 3, relPath: 'a.txt', savedAt: 1, reason: 'discard' };

  it('목록을 열고 복구하면 코어에 넘기고 알린다', async () => {
    const restoreBackup = vi.fn(async () => {});
    const { store } = setup({ listBackups: async () => [rec], restoreBackup });
    await store.getState().openFileBackups();
    expect(store.getState().fileBackups).toEqual([rec]);
    expect(await store.getState().restoreFileBackup(3)).toBe(true);
    expect(restoreBackup).toHaveBeenCalledWith(1, 3);
    expect(notes.length).toBe(1);
    store.getState().closeFileBackups();
    expect(store.getState().fileBackups).toBeNull();
  });

  it('복구 실패는 오류로 남긴다', async () => {
    const { store } = setup({
      restoreBackup: async () => {
        throw { kind: 'internal', message: '다른 저장소의 백업입니다' };
      },
    });
    expect(await store.getState().restoreFileBackup(3)).toBe(false);
    expect(store.getState().actionError).toContain('다른 저장소');
  });
});

describe('WIP 선택과 범위', () => {
  const range = { from: 0, to: 1, newer: 'b', older: 'c', base: 'd', files: [], loading: false };

  it('범위 선택을 지운다', () => {
    const { store } = setup();
    store.setState({ selectedCommit: 'b', range });
    store.getState().selectWip();
    expect(store.getState().range).toBeNull();
  });

  it('열려 있던 범위 diff 도 함께 닫는다', () => {
    const { store } = setup();
    store.setState({
      range,
      selectedFile: {
        path: 'r.ts',
        staged: false,
        commit: null,
        range: { base: 'd', newer: 'b', label: 'c..b' },
      },
      diff: {} as never,
    });
    store.getState().selectWip();
    // 옛 가운데 화면 'graph' 단언 → diff 슬롯이 빈다 (W20)
    expect(store.getState().selectedFile).toBeNull();
    expect(store.getState().diff).toBeNull();
  });

  it('작업 트리 파일 diff 는 건드리지 않는다', () => {
    const { store } = setup();
    const target = { path: 'w.ts', staged: false, commit: null };
    store.setState({ selectedFile: target });
    store.getState().selectWip();
    // 옛 가운데 화면 'diff' 단언 → diff 슬롯이 그 파일 그대로다 (W20)
    expect(store.getState().selectedFile).toBe(target);
  });

  it('범위 계산 중에 WIP 를 고르면 범위가 뒤늦게 살아나지 않는다', async () => {
    let answer: (row: number | null) => void = () => {};
    const { store } = setup({
      findRow: () => new Promise<number | null>((resolve) => (answer = resolve)),
    });
    store.setState({ selectedCommit: 'a'.repeat(40), wipSelected: false });
    const pending = store.getState().selectRange({ oid: 'b'.repeat(40), row: 5 } as never);
    store.getState().selectWip();
    answer(1);
    await pending;
    await flush();
    expect(store.getState().range).toBeNull();
  });
});

describe('범위의 기준 커밋 클릭', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const range = { from: 0, to: 1, newer: A, older: B, base: 'd', files: [], loading: false };
  const rangeDiff = {
    path: 'r.ts',
    staged: false,
    commit: null,
    range: { base: 'd', newer: A, label: 'b..a' },
  };

  it('범위를 지우고 단일 커밋 선택으로 돌아온다 (상세는 다시 읽지 않는다)', () => {
    const commitDetail = vi.fn(async () => ({}) as never);
    const { store } = setup({ commitDetail });
    const detail = { oid: A } as never;
    store.setState({ selectedCommit: A, wipSelected: false, detail, range });
    store.getState().selectCommit(A);
    expect(store.getState().range).toBeNull();
    expect(store.getState().selectedCommit).toBe(A);
    expect(store.getState().detail).toBe(detail);
    expect(commitDetail).not.toHaveBeenCalled();
  });

  it('열려 있던 범위 diff 도 함께 닫는다', () => {
    const { store } = setup();
    store.setState({
      selectedCommit: A,
      range,
      selectedFile: rangeDiff,
      diff: {} as never,
    });
    store.getState().selectCommit(A);
    // 옛 가운데 화면 'graph' 단언 → diff 슬롯이 빈다 (W20)
    expect(store.getState().selectedFile).toBeNull();
    expect(store.getState().diff).toBeNull();
  });

  it('다른 커밋을 골라도 범위 diff 가 남지 않는다', () => {
    const { store } = setup({ commitDetail: async () => ({}) as never });
    store.setState({ selectedCommit: A, range, selectedFile: rangeDiff });
    store.getState().selectCommit(B);
    expect(store.getState().range).toBeNull();
    expect(store.getState().selectedFile).toBeNull();
  });

  it('범위와 무관한 파일 diff 는 건드리지 않는다', () => {
    const { store } = setup({ commitDetail: async () => ({}) as never });
    const target = { path: 'w.ts', staged: false, commit: null };
    store.setState({ selectedCommit: A, range, selectedFile: target });
    store.getState().selectCommit(A);
    expect(store.getState().range).toBeNull();
    // 옛 `toEqual(target)` + 가운데 화면 'diff' 단언 → diff 슬롯이 같은 객체 그대로다 (W20)
    expect(store.getState().selectedFile).toBe(target);
  });

  it('범위가 없으면 같은 커밋을 다시 클릭해도 아무 일도 없다', () => {
    const commitDetail = vi.fn(async () => ({}) as never);
    const { store } = setup({ commitDetail });
    const target = { path: 'w.ts', staged: false, commit: A };
    store.setState({ selectedCommit: A, selectedFile: target });
    store.getState().selectCommit(A);
    expect(store.getState().selectedFile).toEqual(target);
    expect(commitDetail).not.toHaveBeenCalled();
  });

  /** 행 번호 조회를 직접 끝낼 수 있는 클라이언트 */
  function deferredRows() {
    const pending: ((row: number | null) => void)[] = [];
    const findRow = () => new Promise<number | null>((resolve) => pending.push(resolve));
    return { pending, findRow };
  }

  it('범위 계산 중에 기준 커밋을 클릭하면 범위가 뒤늦게 살아나지 않는다', async () => {
    const { pending, findRow } = deferredRows();
    const { store } = setup({ findRow });
    store.setState({ selectedCommit: A, wipSelected: false });
    const running = store.getState().selectRange({ oid: B, row: 5 } as never);
    store.getState().selectCommit(A);
    pending[0]?.(1);
    await running;
    await flush();
    expect(store.getState().range).toBeNull();
  });

  it('연달아 범위를 고르면 늦게 온 앞 요청이 뒤 범위를 덮지 않는다', async () => {
    const { pending, findRow } = deferredRows();
    const rangeFiles = vi.fn(async () => ({ base: 'd', files: [] }));
    const { store } = setup({ findRow, rangeFiles });
    store.setState({ selectedCommit: A, wipSelected: false });
    const first = store.getState().selectRange({ oid: B, row: 5 } as never);
    const second = store.getState().selectRange({ oid: C, row: 9 } as never);
    pending[1]?.(1);
    await second;
    pending[0]?.(1);
    await first;
    expect(store.getState().range?.older).toBe(C);
    expect(rangeFiles).toHaveBeenCalledTimes(1);
  });
});

describe('재로드 뒤 검색 재실행', () => {
  const reloaded = {
    type: 'graphReloaded' as const,
    session: 1,
    generation: 2,
    rows: 10,
    laneCount: 1,
  };
  const found = (rows: number[]) => ({ rows, total: rows.length, truncated: false });
  const text = {
    open: true,
    query: 'x',
    rows: [3, 7],
    total: 2,
    truncated: false,
    cursor: 1,
    advanced: null,
  };
  const advanced = {
    text: null,
    author: 'me',
    path: null,
    pickaxe: null,
    pickaxeRegex: false,
    since: null,
    until: null,
  };

  it('결과는 새로 받되 보던 위치로 스크롤하지 않고 현재 결과 번호를 유지한다', async () => {
    const { store } = setup({ searchCommits: async () => found([4, 8]) });
    store.setState({ search: text });
    store.getState().applyEvent(reloaded);
    await flush();
    expect(store.getState().search.rows).toEqual([4, 8]);
    expect(store.getState().search.cursor).toBe(1);
    expect(store.getState().scrollToRow).toBeNull();
  });

  it('고급 검색도 스크롤하지 않고 조건을 유지한다', async () => {
    const { store } = setup({ searchAdvanced: async () => found([4, 8]) });
    store.setState({ search: { ...text, advanced } });
    store.getState().applyEvent(reloaded);
    await flush();
    expect(store.getState().search.rows).toEqual([4, 8]);
    expect(store.getState().search.advanced).toEqual(advanced);
    expect(store.getState().search.cursor).toBe(1);
    expect(store.getState().scrollToRow).toBeNull();
  });

  it('결과가 줄면 번호를 마지막 결과로 맞춘다', async () => {
    const { store } = setup({ searchCommits: async () => found([4]) });
    store.setState({ search: { ...text, cursor: 5 } });
    store.getState().applyEvent(reloaded);
    await flush();
    expect(store.getState().search.cursor).toBe(0);
  });

  it('재실행 뒤 다음 결과 이동은 이어지고 스크롤한다', async () => {
    const { store } = setup({ searchCommits: async () => found([2, 4, 8]) });
    store.setState({ search: text });
    store.getState().applyEvent(reloaded);
    await flush();
    store.getState().searchStep(1);
    expect(store.getState().search.cursor).toBe(2);
    expect(store.getState().scrollToRow).toBe(8);
  });

  it('사용자가 직접 한 검색은 첫 결과로 스크롤한다', async () => {
    const { store } = setup({
      searchCommits: async () => found([4, 8]),
      searchAdvanced: async () => found([6]),
    });
    await store.getState().runSearch('x');
    expect(store.getState().scrollToRow).toBe(4);
    store.getState().consumeScroll();
    await store.getState().runAdvancedSearch(advanced);
    expect(store.getState().scrollToRow).toBe(6);
  });

  it('사용자 검색이 도는 중에 재로드가 오면 그 검색을 다시 돌리고 스크롤도 유지한다', async () => {
    const queries: string[] = [];
    const pending: (() => void)[] = [];
    const searchCommits = vi.fn(
      (_s: number, query: string) =>
        new Promise<ReturnType<typeof found>>((resolve) => {
          queries.push(query);
          pending.push(() => resolve(found([query === 'new' ? 5 : 1])));
        }),
    );
    const { store } = setup({ searchCommits });
    store.setState({ search: { ...text, query: 'old' } });
    void store.getState().runSearch('new');
    store.getState().applyEvent(reloaded);
    for (const finish of pending) {
      finish();
    }
    await flush();
    expect(queries).toEqual(['new', 'new']);
    expect(store.getState().search.query).toBe('new');
    expect(store.getState().scrollToRow).toBe(5);
  });

  it('재실행 응답이 오기 전에 사용자가 새로 검색하면 사용자 결과가 남는다', async () => {
    const pending: ((rows: number[]) => void)[] = [];
    const searchCommits = vi.fn(
      () =>
        new Promise<ReturnType<typeof found>>((resolve) => {
          pending.push((rows) => resolve(found(rows)));
        }),
    );
    const { store } = setup({ searchCommits });
    store.setState({ search: text });
    store.getState().applyEvent(reloaded);
    const user = store.getState().runSearch('y');
    pending[1]?.([9]);
    await user;
    pending[0]?.([1]);
    await flush();
    expect(store.getState().search.query).toBe('y');
    expect(store.getState().search.rows).toEqual([9]);
    expect(store.getState().scrollToRow).toBe(9);
  });

  it('검색을 닫으면 도는 중이던 사용자 검색을 재로드가 되살리지 않는다', async () => {
    const searchCommits = vi.fn(() => new Promise<ReturnType<typeof found>>(() => {}));
    const { store } = setup({ searchCommits });
    store.getState().setSearchOpen(true);
    void store.getState().runSearch('abc');
    store.getState().setSearchOpen(false);
    store.getState().applyEvent(reloaded);
    await flush();
    expect(searchCommits).toHaveBeenCalledTimes(1);
    expect(store.getState().search.open).toBe(false);
  });
});
