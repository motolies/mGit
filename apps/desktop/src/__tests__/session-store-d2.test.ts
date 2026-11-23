import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
  type StatusEntry,
  type WorkTreeStatus,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';

const HEAD = 'a'.repeat(40);

/** 충돌 해결 보조 호출을 기록하는 클라이언트 */
function client() {
  let rules: { glob: string; action: { kind: 'ours' } }[] = [];
  const c: IpcClient = {
    ...createNullClient(),
    conflictOrigins: vi.fn(async () => ({
      ours: [{ oid: 'c'.repeat(40), subject: 'main change', author: 't', time: 1 }],
      theirs: [{ oid: 'd'.repeat(40), subject: 'other change', author: 't', time: 2 }],
      current: null,
    })),
    mergeToolName: vi.fn(async () => 'meld'),
    openMergetool: vi.fn(async () => {}),
    conflictRules: vi.fn(async () => rules),
    conflictRulesSet: vi.fn(async (_s, next: { glob: string; action: { kind: 'ours' } }[]) => {
      rules = next;
    }),
    conflictRulesApply: vi.fn(async () => [
      { path: 'a.lock', glob: '*.lock', ok: true, message: '' },
      { path: 'b.txt', glob: '*.txt', ok: false, message: 'boom' },
    ]),
    renameConflicts: vi.fn(async () => [
      { basePath: 'old.txt', oursPath: 'a.txt', theirsPath: 'b.txt' },
    ]),
    resolveRename: vi.fn(async () => 'a.txt'),
    rerereStatus: vi.fn(async () => ({ enabled: true, autoupdate: false, resolvedPaths: ['f'] })),
    keptResolutions: vi.fn(async () => [
      { path: 'f', opKey: 'k', resolved: 'e'.repeat(40), time: 1, matchesCurrent: true },
    ]),
    reapplyResolutions: vi.fn(async () => 1),
    resolutionReview: vi.fn(async () => ({
      path: 'f',
      auto: '<<<<<<<\n',
      resolved: 'x\n',
      diff: '-<<<<<<<\n+x\n',
      autoHadConflicts: true,
    })),
    remergeDiff: vi.fn(async () => ''),
  };
  return c;
}

/** 스토어 */
function setup() {
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
  const c = client();
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  return { store: createSessionStore(opened, c, cache), client: c, opened };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 충돌 파일 하나가 있는 상태 */
function conflictedStatus(base: WorkTreeStatus): WorkTreeStatus {
  const entry = { path: 'f', conflict: true } as unknown as StatusEntry;
  return {
    ...base,
    entries: [entry],
    summary: { ...base.summary, conflicted: 1 },
  };
}

describe('SessionStore (D2 충돌 해결 보조)', () => {
  it('출처·외부 도구 이름을 읽는다', async () => {
    const { store, client: c } = setup();
    await store.getState().loadConflictOrigins('f');
    expect(c.conflictOrigins).toHaveBeenCalledWith(1, 'f');
    expect(store.getState().origins?.data?.ours[0]?.subject).toBe('main change');
    await store.getState().loadMergeTool();
    expect(store.getState().mergeTool).toBe('meld');
    await store.getState().openMergetool('f');
    expect(c.openMergetool).toHaveBeenCalledWith(1, 'f');
  });

  it('규칙을 저장하고 적용 결과를 알린다', async () => {
    const { store, client: c } = setup();
    await store.getState().saveRules([{ glob: '*.lock', action: { kind: 'ours' } }]);
    expect(c.conflictRulesSet).toHaveBeenCalledWith(1, [
      { glob: '*.lock', action: { kind: 'ours' } },
    ]);
    expect(store.getState().rules).toEqual([{ glob: '*.lock', action: { kind: 'ours' } }]);
    await store.getState().applyRules();
    expect(store.getState().ruleResults?.map((r) => r.ok)).toEqual([true, false]);
  });

  it('충돌이 생기면 이름 변경·rerere·보관을 읽고, 보관된 해결이 있으면 재적용을 제안한다', async () => {
    const { store, client: c, opened } = setup();
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: conflictedStatus(opened.state.status),
      op: { kind: 'merge', head: 'b'.repeat(40) },
    });
    await tick();
    await tick();
    expect(c.renameConflicts).toHaveBeenCalled();
    expect(store.getState().renameConflicts).toHaveLength(1);
    expect(store.getState().rerere.resolvedPaths).toEqual(['f']);
    expect(store.getState().kept).toHaveLength(1);
    expect(store.getState().pendingHint).toEqual({ kind: 'reapplyResolutions', count: 1 });
    store.getState().dismissHint();
    await store.getState().reapplyKept();
    expect(c.reapplyResolutions).toHaveBeenCalledWith(1);
    // 같은 작업에서는 다시 제안하지 않는다
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: conflictedStatus(opened.state.status),
      op: { kind: 'merge', head: 'b'.repeat(40) },
    });
    await tick();
    await tick();
    expect(store.getState().pendingHint).toBeNull();
  });

  it('이름 변경 충돌을 해결하고 리뷰를 연다', async () => {
    const { store, client: c } = setup();
    await store
      .getState()
      .resolveRename({ basePath: 'old.txt', oursPath: 'a.txt', theirsPath: 'b.txt' }, 'ours');
    expect(c.resolveRename).toHaveBeenCalledWith(
      1,
      { basePath: 'old.txt', oursPath: 'a.txt', theirsPath: 'b.txt' },
      'ours',
    );
    await store.getState().openReview('f');
    expect(store.getState().review?.text).toContain('+x');
    expect(store.getState().review?.loading).toBe(false);
    await store.getState().openRemergeDiff('c'.repeat(40));
    expect(c.remergeDiff).toHaveBeenCalledWith(1, 'c'.repeat(40));
    expect(store.getState().review?.text).toBe('');
    store.getState().closeReview();
    expect(store.getState().review).toBeNull();
  });
});
