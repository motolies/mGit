import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type MergePreview,
  type RepoOpened,
} from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

/** 미리보기 결과 (ours 옵션이면 깨끗) */
function previewOf(theirs: string, strategy: string[], wip: boolean): MergePreview {
  const clean = strategy.includes('ours');
  return {
    ours: 'HEAD',
    theirs,
    clean,
    conflicts: clean ? [] : ['f.txt'],
    tree: TREE,
    messages: clean ? [] : ['CONFLICT (content): Merge conflict in f.txt'],
    strategy,
    wipIncluded: wip,
  };
}

/** 충돌 예방 호출을 기록하는 클라이언트 */
function client(isolated: string | null) {
  const c: IpcClient = {
    ...createNullClient(),
    mergePreview: vi.fn(async (_s, ref: string, strategy: string[], wip: boolean) =>
      previewOf(ref, strategy, wip),
    ),
    mergeSimulate: vi.fn(async (_s, ref: string, wip: boolean) => [
      previewOf(ref, [], wip),
      previewOf(ref, ['ours'], wip),
    ]),
    previewFile: vi.fn(async () => '<<<<<<< ours\nc\n=======\nb\n>>>>>>> side\n'),
    mergeWithOptions: vi.fn(async () => 'clean' as const),
    rebasePreview: vi.fn(async () => [
      {
        oid: 'c'.repeat(40),
        subject: 'main f',
        clean: false,
        conflicts: ['f.txt'],
        approximate: false,
      },
    ]),
    conflictRadar: vi.fn(async () => [
      {
        reference: 'side',
        kind: 'local' as const,
        clean: false,
        conflicts: ['f.txt'],
        behind: 1,
        ahead: 1,
      },
    ]),
    isolatedMerge: vi.fn(async () => ({
      worktree: '/r.worktrees/_merge-1',
      branch: 'mgit/isolated-1',
      outcome: 'conflicts' as const,
    })),
    isolatedInfo: vi.fn(async () => isolated),
    isolatedApply: vi.fn(async () => '/r'),
    isolatedDiscard: vi.fn(async () => '/r'),
  };
  return c;
}

/** 스토어 */
function setup(isolated: string | null = null) {
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
  const c = client(isolated);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, c, cache), client: c, opened };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SessionStore (D1 충돌 예방)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('병합 미리보기: 결과·WIP 토글·옵션 비교·파일 내용·고른 옵션으로 실행', async () => {
    const { store, client: c } = setup();
    await store.getState().openMergePreview('side');
    const p = store.getState().preview;
    expect(p?.result?.conflicts).toEqual(['f.txt']);
    expect(p?.loading).toBe(false);
    await store.getState().previewSetWip(true);
    expect(c.mergePreview).toHaveBeenLastCalledWith(1, 'side', [], true);
    expect(store.getState().preview?.result?.wipIncluded).toBe(true);
    await store.getState().previewSimulate();
    expect(store.getState().preview?.simulate?.map((x) => x.clean)).toEqual([false, true]);
    await store.getState().previewOpenFile('f.txt');
    expect(c.previewFile).toHaveBeenCalledWith(1, TREE, 'f.txt');
    expect(store.getState().preview?.file?.content).toContain('<<<<<<<');
    await store.getState().previewRun(['ours'], 'default');
    expect(c.mergeWithOptions).toHaveBeenCalledWith(1, 'side', 'default', ['ours']);
    expect(store.getState().preview).toBeNull();
    expect(store.getState().lastOutcome).toBe('clean');
  });

  it('rebase 예측을 연다', async () => {
    const { store, client: c } = setup();
    await store.getState().openRebasePreview('side');
    expect(c.rebasePreview).toHaveBeenCalledWith(1, 'side');
    expect(store.getState().rebasePreview?.steps.map((x) => x.subject)).toEqual(['main f']);
    store.getState().closeRebasePreview();
    expect(store.getState().rebasePreview).toBeNull();
  });

  it('레이더는 열 때와 ref 변경 1.5초 뒤에 다시 계산한다', async () => {
    const { store, client: c, opened } = setup();
    await tick();
    await tick();
    expect(c.conflictRadar).toHaveBeenCalledTimes(1);
    expect(store.getState().radar.map((r) => r.reference)).toEqual(['side']);
    vi.useFakeTimers();
    store.getState().applyEvent({ type: 'refsChanged', session: 1, refs: opened.state.refs });
    store.getState().applyEvent({ type: 'refsChanged', session: 1, refs: opened.state.refs });
    expect(c.conflictRadar).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1600);
    expect(c.conflictRadar).toHaveBeenCalledTimes(2);
  });

  it('격리 병합: 시작하면 워크트리 경로를 주고, 격리 세션에서는 반영·버리기가 메인 경로를 준다', async () => {
    const { store, client: c } = setup();
    const path = await store.getState().isolatedMerge('side', 'default');
    expect(c.isolatedMerge).toHaveBeenCalledWith(1, 'side', 'default');
    expect(path).toBe('/r.worktrees/_merge-1');
    const iso = setup('mgit/isolated-1');
    await tick();
    await tick();
    expect(iso.store.getState().isolatedBranch).toBe('mgit/isolated-1');
    expect(await iso.store.getState().isolatedApply()).toBe('/r');
    expect(await iso.store.getState().isolatedDiscard()).toBe('/r');
  });
});
