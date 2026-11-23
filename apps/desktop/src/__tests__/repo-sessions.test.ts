import { describe, expect, it } from 'vitest';
import {
  activeRepoLocked,
  asBorrowed,
  type BusyFields,
  foldersUsing,
  heldCount,
  ledgerReferences,
  nextActiveRepo,
  pickEvictable,
  type RepoSessionLedger,
  reconcileLedger,
  scopeSessionId,
  sessionBusy,
  sessionDialogOpen,
  sessionHasWork,
  withoutSession,
} from '../store/repo-sessions';

/** 한가한 세션 상태 */
const IDLE: BusyFields = {
  busy: false,
  committing: false,
  operations: {},
  conflictDrafts: {},
  blame: null,
  fileHistory: null,
};

/** 장시간 명령 하나 (끝났는지만 본다) */
function op(done: boolean): BusyFields['operations'] {
  return { 1: { id: 1, done } } as unknown as BusyFields['operations'];
}

/** 항목 하나 */
const entry = (session: number, usedAt: number, held = true) => ({ session, held, usedAt });

describe('범위 세션 id (계획 5.1 의 이음새)', () => {
  const ledgers = { 10: { '/f/api': entry(21, 1), '/f/web': entry(22, 2) } };

  it('저장소 탭은 그 탭의 세션이다 (장부·활성 저장소와 무관)', () => {
    expect(scopeSessionId({ tab: { id: 5, kind: 'repo' }, ledgers, activeRepo: '/f/api' })).toBe(5);
  });

  it('폴더 탭은 활성 저장소의 숨은 세션이고, 열려 있지 않으면 없다', () => {
    const tab = { id: 10, kind: 'folder' } as const;
    expect(scopeSessionId({ tab, ledgers, activeRepo: '/f/api' })).toBe(21);
    expect(scopeSessionId({ tab, ledgers, activeRepo: '/f/web' })).toBe(22);
    // 활성 저장소만 바뀌어서는 세션이 생기지 않는다
    expect(scopeSessionId({ tab, ledgers, activeRepo: '/f/auth' })).toBeNull();
    expect(scopeSessionId({ tab, ledgers, activeRepo: null })).toBeNull();
    // 다른 폴더 탭의 장부는 보지 않는다
    expect(scopeSessionId({ tab: { id: 11, kind: 'folder' }, ledgers, activeRepo: '/f/api' })).toBe(
      null,
    );
  });

  it('탭이 없으면 없다', () => {
    expect(scopeSessionId({ tab: null, ledgers, activeRepo: '/f/api' })).toBeNull();
  });
});

describe('바쁨 판정', () => {
  it('작업: 쓰기·커밋·끝나지 않은 장시간 명령·충돌 초안. 끝난 명령은 아니다', () => {
    expect(sessionHasWork(IDLE)).toBe(false);
    expect(sessionHasWork({ ...IDLE, busy: true })).toBe(true);
    expect(sessionHasWork({ ...IDLE, committing: true })).toBe(true);
    expect(sessionHasWork({ ...IDLE, operations: op(false) })).toBe(true);
    expect(sessionHasWork({ ...IDLE, operations: op(true) })).toBe(false);
    expect(
      sessionHasWork({
        ...IDLE,
        conflictDrafts: { 'a.txt': {} } as unknown as BusyFields['conflictDrafts'],
      }),
    ).toBe(true);
  });

  it('대화상자: 폴더 탭에 마운트되는 blame·파일 히스토리', () => {
    const blame = { path: 'a', rev: null, lines: [], loading: true, error: null };
    const history = { path: 'a', entries: [], loading: true };
    expect(sessionDialogOpen(IDLE)).toBe(false);
    expect(sessionDialogOpen({ ...IDLE, blame })).toBe(true);
    expect(sessionDialogOpen({ ...IDLE, fileHistory: history })).toBe(true);
    expect(sessionBusy({ ...IDLE, fileHistory: history })).toBe(true);
    expect(sessionBusy({ ...IDLE, busy: true })).toBe(true);
    expect(sessionBusy(IDLE)).toBe(false);
  });
});

describe('상한에서 놓을 세션 (LRU)', () => {
  const ledger: RepoSessionLedger = {
    '/f/a': entry(1, 300),
    '/f/b': entry(2, 100),
    '/f/c': entry(3, 200),
    // 빌린 탭 세션은 가장 오래됐어도 놓지 않고 세지도 않는다
    '/f/tab': entry(9, 1, false),
  };

  it('잡은 세션만 센다', () => {
    expect(heldCount(ledger)).toBe(3);
    expect(heldCount({})).toBe(0);
  });

  it('바쁘지 않은 것 중 가장 오래 안 쓴 것', () => {
    expect(pickEvictable(ledger, () => false)).toBe('/f/b');
    expect(pickEvictable(ledger, (s) => s === 2)).toBe('/f/c');
    expect(pickEvictable(ledger, (s) => s !== 1)).toBe('/f/a');
  });

  it('전부 바쁘면 null', () => {
    expect(pickEvictable(ledger, () => true)).toBeNull();
    expect(pickEvictable({ '/f/tab': entry(9, 1, false) }, () => false)).toBeNull();
  });

  it('같은 시각이면 경로순으로 정한다', () => {
    expect(pickEvictable({ '/f/z': entry(1, 5), '/f/m': entry(2, 5) }, () => false)).toBe('/f/m');
  });
});

describe('장부 맞추기 (lightSessionLimit 회복)', () => {
  const hasTab = (s: number) => s === 7;

  it('코어 목록에 없는 잡음은 탭이 있으면 빌림(승격), 없으면 지운다', () => {
    const r = reconcileLedger(
      { '/f/a': entry(1, 1), '/f/b': entry(7, 2), '/f/c': entry(3, 3) },
      [1],
      hasTab,
    );
    expect(r.ledger).toEqual({ '/f/a': entry(1, 1), '/f/b': entry(7, 2, false) });
    expect(r.dropped).toEqual([3]);
    expect(r.orphans).toEqual([]);
  });

  it('코어가 잡았다고 하는데 장부에 없는 세션은 놓을 대상(orphans), 빌림인데 코어가 잡았으면 잡음으로', () => {
    const r = reconcileLedger({ '/f/a': entry(1, 1, false) }, [1, 4, 5], hasTab);
    expect(r.ledger).toEqual({ '/f/a': entry(1, 1) });
    expect(r.orphans).toEqual([4, 5]);
  });

  it('빌린 탭이 이미 닫혔으면 지운다', () => {
    const r = reconcileLedger({ '/f/a': entry(8, 1, false) }, [], hasTab);
    expect(r.ledger).toEqual({});
    expect(r.dropped).toEqual([8]);
  });
});

describe('장부 전체 다루기', () => {
  const ledgers = {
    10: { '/f/api': entry(21, 1), '/f/web': entry(22, 2) },
    11: { '/g/api': entry(21, 3) },
  };

  it('어느 폴더든 가리키는지, 누가 가리키는지', () => {
    expect(ledgerReferences(ledgers, 21)).toBe(true);
    expect(ledgerReferences(ledgers, 99)).toBe(false);
    expect(foldersUsing(ledgers, 21)).toEqual([
      { folder: 10, repoPath: '/f/api' },
      { folder: 11, repoPath: '/g/api' },
    ]);
    expect(foldersUsing(ledgers, 99)).toEqual([]);
  });

  it('탭을 닫으면 그 세션을 가리키는 항목을 모든 폴더에서 지운다. 상관없으면 같은 객체', () => {
    expect(withoutSession(ledgers, 21)).toEqual({ 10: { '/f/web': entry(22, 2) }, 11: {} });
    expect(withoutSession(ledgers, 99)).toBe(ledgers);
  });

  it('승격하면 그 세션을 가리키는 잡음이 빌림이 된다', () => {
    expect(asBorrowed(ledgers, 21)).toEqual({
      10: { '/f/api': entry(21, 1, false), '/f/web': entry(22, 2) },
      11: { '/g/api': entry(21, 3, false) },
    });
    expect(asBorrowed(ledgers, 99)).toBe(ledgers);
  });
});

describe('활성 저장소 전환 차단 (계획 5.1)', () => {
  it('세션을 여는 중이거나 범위 세션이 바쁘면 잠근다', () => {
    expect(activeRepoLocked({ opening: false, scope: null })).toBe(false);
    expect(activeRepoLocked({ opening: true, scope: null })).toBe(true);
    expect(activeRepoLocked({ opening: false, scope: IDLE })).toBe(false);
    expect(activeRepoLocked({ opening: false, scope: { ...IDLE, busy: true } })).toBe(true);
    expect(
      activeRepoLocked({
        opening: false,
        scope: { ...IDLE, blame: { path: 'a', rev: null, lines: [], loading: false, error: null } },
      }),
    ).toBe(true);
  });

  it('잠겨 있으면 다른 저장소로 옮기지 않는다. 같은 저장소·"그대로"(null)는 상관없다', () => {
    expect(nextActiveRepo('/f/api', '/f/web', false)).toBe('/f/web');
    expect(nextActiveRepo('/f/api', '/f/web', true)).toBe('/f/api');
    expect(nextActiveRepo('/f/api', '/f/api', true)).toBe('/f/api');
    expect(nextActiveRepo('/f/api', null, false)).toBe('/f/api');
    expect(nextActiveRepo(null, '/f/web', true)).toBeNull();
    expect(nextActiveRepo(null, '/f/web', false)).toBe('/f/web');
  });
});
