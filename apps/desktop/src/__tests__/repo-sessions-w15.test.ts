import { describe, expect, it } from 'vitest';
import {
  activeRepoLocked,
  type BusyFields,
  folderCloseRisks,
  folderHintMode,
  folderHintPending,
  folderHintSession,
  type RepoSessionLedger,
  sessionBusy,
  sessionDialogOpen,
  sessionHasWork,
  sessionHoldsScope,
  sessionInFlight,
  sessionSlotAvailable,
} from '../store/repo-sessions';
import type { PendingHint } from '../store/session-store';

/** 한가한 세션 상태 */
const IDLE: BusyFields = {
  busy: false,
  committing: false,
  operations: {},
  conflictDrafts: {},
  blame: null,
  fileHistory: null,
  pendingHint: null,
};

/** 초안 하나가 있는 상태 */
const DRAFT: BusyFields = {
  ...IDLE,
  conflictDrafts: { 'a.kt': { text: 'x', ranges: [], key: 'k' } },
};

const SPEC = {
  remote: 'origin',
  setUpstream: false,
  tags: false,
  forceWithLease: false,
  confirmUpstreamMismatch: false,
  rememberUpstreamMismatch: false,
};

/** 항목 하나 */
const entry = (session: number, usedAt: number, held = true) => ({ session, held, usedAt });

describe('초안과 활성 저장소 잠금 (W15)', () => {
  it('초안만 있으면 활성 저장소를 붙잡지 않는다 — 놓으면 잃는 것(상한에서 놓지 않음)에는 든다', () => {
    expect(sessionInFlight(DRAFT)).toBe(false);
    expect(sessionHoldsScope(DRAFT)).toBe(false);
    expect(activeRepoLocked({ opening: false, scope: DRAFT })).toBe(false);
    expect(sessionHasWork(DRAFT)).toBe(true);
    expect(sessionBusy(DRAFT)).toBe(true);
  });

  it('도는 쓰기·보이는 대화상자는 지금처럼 잠근다', () => {
    expect(activeRepoLocked({ opening: false, scope: { ...IDLE, busy: true } })).toBe(true);
    expect(
      activeRepoLocked({ opening: false, scope: { ...IDLE, pendingHint: { kind: 'indexLock' } } }),
    ).toBe(true);
    expect(sessionInFlight({ ...IDLE, committing: true })).toBe(true);
  });
});

describe('폴더 탭의 힌트 표 (W15)', () => {
  const ALL: PendingHint[] = [
    { kind: 'dirtyWorkTree', files: [], target: { kind: 'branch', name: 'x' } },
    { kind: 'remoteBranchTaken', local: 'x', remote: 'o', name: 'x', upstream: null, oid: null },
    { kind: 'notFullyMerged', name: 'x' },
    { kind: 'branchElsewhere', path: '/p', name: 'x' },
    { kind: 'nonFastForward', spec: SPEC },
    { kind: 'staleInfo', spec: SPEC },
    { kind: 'indexLock' },
    { kind: 'detachedHead' },
    { kind: 'noUpstream' },
    { kind: 'hookFailed' },
    { kind: 'nothingToCommit' },
    { kind: 'nestedRepo', paths: [] },
    { kind: 'submoduleUnpushed', items: [], spec: SPEC },
    { kind: 'pushUpstreamMismatch', local: 'x', remote: 'o', upstream: 'y', spec: SPEC },
    { kind: 'conflictMarkers', files: [], retry: { kind: 'opContinue' } },
    {
      kind: 'conflictMarkers',
      files: [],
      retry: { kind: 'saveConflict', content: '', force: false },
    },
    { kind: 'conflictMarkers', files: [], retry: { kind: 'commit', ignoreSecrets: false } },
    { kind: 'reapplyResolutions', count: 1 },
    {
      kind: 'syntaxErrors',
      path: 'a',
      content: '',
      compare: {} as never,
      allowConflictMarkers: false,
    },
  ];

  it('켬: index.lock·충돌 마커(계속·저장)·구문 오류·보관 해결·commit 없음 / 안내만: hook / 끔: 나머지', () => {
    const table = ALL.map((h) => [
      h.kind === 'conflictMarkers' ? `${h.kind}:${h.retry.kind}` : h.kind,
      folderHintMode(h),
    ]);
    expect(Object.fromEntries(table)).toEqual({
      dirtyWorkTree: 'off',
      remoteBranchTaken: 'off',
      notFullyMerged: 'off',
      branchElsewhere: 'off',
      nonFastForward: 'off',
      staleInfo: 'off',
      indexLock: 'act',
      detachedHead: 'off',
      noUpstream: 'off',
      hookFailed: 'info',
      nothingToCommit: 'act',
      nestedRepo: 'off',
      submoduleUnpushed: 'off',
      pushUpstreamMismatch: 'off',
      'conflictMarkers:opContinue': 'act',
      'conflictMarkers:saveConflict': 'act',
      'conflictMarkers:commit': 'off',
      reapplyResolutions: 'act',
      syntaxErrors: 'act',
    });
  });

  it('보이는 힌트만 대화상자로 센다 (끈 힌트를 세면 닫을 수 없어 영영 바쁘다)', () => {
    expect(folderHintPending({ pendingHint: { kind: 'hookFailed' } })).toBe(true);
    expect(folderHintPending({ pendingHint: { kind: 'nonFastForward', spec: SPEC } })).toBe(false);
    expect(folderHintPending({})).toBe(false);
    expect(sessionDialogOpen({ ...IDLE, pendingHint: { kind: 'indexLock' } })).toBe(true);
    expect(sessionDialogOpen({ ...IDLE, pendingHint: { kind: 'noUpstream' } })).toBe(false);
    expect(sessionBusy({ ...IDLE, pendingHint: { kind: 'noUpstream' } })).toBe(false);
  });

  it('한 번에 하나: 범위 세션 → 보이는 문서의 세션 → 경로순', () => {
    const ledger: RepoSessionLedger = {
      '/f/web': entry(3, 1),
      '/f/api': entry(1, 1),
      '/f/catalog': entry(2, 1),
    };
    const all = () => true;
    expect(folderHintSession(ledger, all, 3, 2)).toEqual({ repoPath: '/f/web', session: 3 });
    expect(folderHintSession(ledger, (s) => s !== 3, 3, 2)).toEqual({
      repoPath: '/f/catalog',
      session: 2,
    });
    expect(folderHintSession(ledger, (s) => s !== 2, null, 2)).toEqual({
      repoPath: '/f/api',
      session: 1,
    });
    expect(folderHintSession(ledger, () => false, 3, 2)).toBeNull();
    // 다른 폴더의 세션(장부에 없는 범위 세션)은 보지 않는다
    expect(folderHintSession(ledger, (s) => s === 9, 9, null)).toBeNull();
  });
});

describe('세션 상한에서 실행할 수 있는지 (W15 띠)', () => {
  const full: RepoSessionLedger = {
    '/f/a': entry(1, 1),
    '/f/b': entry(2, 2),
    '/f/c': entry(3, 3),
  };

  it('장부에 있거나, 상한 밑이거나, 놓을 수 있는 세션이 있으면 된다', () => {
    expect(sessionSlotAvailable(full, '/f/a', () => true)).toBe(true);
    expect(sessionSlotAvailable({ '/f/a': entry(1, 1) }, '/f/x', () => true)).toBe(true);
    expect(sessionSlotAvailable(full, '/f/x', (s) => s !== 2)).toBe(true);
    expect(sessionSlotAvailable(full, '/f/x', () => true)).toBe(false);
    // 빌린 탭 세션은 상한에 세지 않는다
    expect(sessionSlotAvailable({ ...full, '/f/a': entry(1, 1, false) }, '/f/x', () => true)).toBe(
      true,
    );
  });
});

describe('폴더 탭 닫기 판정 (WS-21)', () => {
  it('하위 저장소 탭이 있으면 탭마다, 숨은 세션의 초안·도는 작업은 저장소마다 한 줄', () => {
    expect(
      folderCloseRisks({
        children: [
          { name: 'web', drafts: [] },
          { name: 'api', drafts: ['a.kt'] },
        ],
        held: [
          { repoName: 'catalog', drafts: ['b.kt', 'c.kt'], running: true },
          { repoName: 'auth', drafts: [], running: false },
        ],
      }),
    ).toEqual([
      { kind: 'childTab', name: 'web', drafts: [] },
      { kind: 'childTab', name: 'api', drafts: ['a.kt'] },
      { kind: 'draft', repoName: 'catalog', paths: ['b.kt', 'c.kt'] },
      { kind: 'running', repoName: 'catalog' },
    ]);
  });

  it('잃는 것이 없으면 빈 목록 (확인 없이 닫는다)', () => {
    expect(
      folderCloseRisks({
        children: [],
        held: [{ repoName: 'auth', drafts: [], running: false }],
      }),
    ).toEqual([]);
  });
});
