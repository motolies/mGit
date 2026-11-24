import {
  type AuthorList,
  type CommitDetail,
  createNullClient,
  type GraphQuery,
  type IpcClient,
  IpcClientError,
  type TimelineInfo,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { withAuthors, withDates, withText } from '../features/filter-bar/filter-model';
import {
  createFolderStore,
  DEFAULT_TIMELINE_PREFS,
  DEFAULT_TIMELINE_QUERY,
  scopeOfInfo,
  selectionInScope,
  timelineScopePending,
} from '../store/folder-store';

const Q: GraphQuery = DEFAULT_TIMELINE_QUERY;
const API = '/f/api';
const WEB = '/f/web';
const OID = 'a'.repeat(40);
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 타임라인 정보. `scope` 를 주면 그 저장소만 범위 안이다 */
function info(scope: string[] = []): TimelineInfo {
  return {
    generation: 1,
    rows: 10,
    finished: true,
    maxPerRepo: 10000,
    repos: [API, WEB].map((path, index) => ({
      index,
      name: path.split('/').pop() ?? '',
      path,
      color: index,
      headBranch: 'main',
      truncated: false,
      inScope: scope.length === 0 || scope.includes(path),
    })),
    scoped: scope.length > 0,
  };
}

const AUTHORS: AuthorList = {
  authors: [{ name: '서하린', email: 'harin.seo@example.com', commits: 3 }],
  total: 1,
  truncated: false,
  timedOut: false,
};

/** 미뤄 둔 약속 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 타임라인 IPC 를 기록하는 클라이언트 */
function client(overrides: Partial<IpcClient> = {}) {
  let current = info();
  const c = {
    ...createNullClient(),
    folderSummaries: vi.fn(async () => []),
    folderTimelineOpen: vi.fn(async () => current),
    folderTimelineInfo: vi.fn(async () => current),
    folderTimelineReload: vi.fn(async () => {}),
    folderTimelineQuerySet: vi.fn<IpcClient['folderTimelineQuerySet']>(async () => {}),
    folderTimelineScopeSet: vi.fn<IpcClient['folderTimelineScopeSet']>(async (_s, repos) => {
      current = info(repos);
    }),
    folderTimelinePrefsSet: vi.fn<IpcClient['folderTimelinePrefsSet']>(async () => {}),
    folderTimelineAuthors: vi.fn<IpcClient['folderTimelineAuthors']>(async () => AUTHORS),
    folderTimelineFindRow: vi.fn<IpcClient['folderTimelineFindRow']>(async () => 7),
    folderCommitDetail: vi.fn(async () => ({ oid: OID }) as unknown as CommitDetail),
  };
  // 바꾼 메서드도 기록용 함수 자리에 넣는다 (타입은 기록용 그대로 둔다)
  return Object.assign(c, overrides) as typeof c;
}

/** 타임라인을 연 폴더 스토어 */
async function opened(c: ReturnType<typeof client>) {
  const store = createFolderStore({ session: 9, path: '/f', repos: [] }, c);
  await store.getState().openTimeline();
  await tick();
  return store;
}

/** 다시 읽힌 데이터가 왔다 */
const reloaded = (store: Awaited<ReturnType<typeof opened>>, generation: number) =>
  store.getState().applyEvent({
    type: 'graphReloaded',
    session: 9,
    generation,
    rows: 4,
    laneCount: 1,
  });

const invalid = () => new IpcClientError({ kind: 'invalidFilter', message: '잘못된 정규식: (' });

describe('질의 변경과 잘못된 정규식 (W17)', () => {
  it('바꾸면 곧바로 그 질의가 되고 선택·상세를 비우며 읽는 중이 된다', async () => {
    const c = client();
    const store = await opened(c);
    store.getState().selectTimelineRow(WEB, OID);
    await tick();
    const q = withText(Q, { pattern: 'fix', regex: false, matchCase: false });
    const p = store.getState().setTimelineQuery(q);
    expect(store.getState().timeline).toMatchObject({
      query: q,
      selected: null,
      detail: null,
      loadState: 'loading',
      filterError: null,
    });
    await p;
    expect(c.folderTimelineQuerySet).toHaveBeenCalledWith(9, q);
  });

  it('invalidFilter 면 받아들여진 질의와 그때의 선택·상세로 되돌리고 사유를 둔다 (로그는 그대로)', async () => {
    const c = client();
    const store = await opened(c);
    const ok = withText(Q, { pattern: 'fix', regex: true, matchCase: false });
    await store.getState().setTimelineQuery(ok);
    reloaded(store, 2);
    store.getState().selectTimelineRow(WEB, OID);
    await tick();
    expect(store.getState().timeline.detail?.state).toBe('ready');
    const rows = store.getState().timeline.totalRows;

    c.folderTimelineQuerySet.mockRejectedValueOnce(invalid());
    await store
      .getState()
      .setTimelineQuery(withText(Q, { pattern: '(', regex: true, matchCase: false }));
    const t = store.getState().timeline;
    expect(t.query).toBe(ok);
    expect(t.filterError).toBe('잘못된 정규식: (');
    expect(t.selected).toEqual({ repoPath: WEB, oid: OID });
    expect(t.detail?.state).toBe('ready');
    expect(t.loadState).toBe('complete');
    expect(t.totalRows).toBe(rows);
    // 상세를 다시 읽지 않았다
    expect(c.folderCommitDetail).toHaveBeenCalledTimes(1);

    store.getState().clearFilterError();
    expect(store.getState().timeline.filterError).toBeNull();
  });

  it('늦게 실패한 옛 요청은 무시한다 (더 나중 요청이 정한다)', async () => {
    const first = deferred<void>();
    const c = client();
    c.folderTimelineQuerySet.mockImplementationOnce(() => first.promise);
    const store = await opened(c);
    const a = withText(Q, { pattern: '(', regex: true, matchCase: false });
    const b = withAuthors(Q, ['harin.seo@example.com']);
    const pa = store.getState().setTimelineQuery(a);
    await store.getState().setTimelineQuery(b);
    first.reject(invalid());
    await pa;
    expect(store.getState().timeline.query).toBe(b);
    expect(store.getState().timeline.filterError).toBeNull();
  });

  it('다른 오류는 질의를 두고 오류로 표시한다', async () => {
    const c = client({
      folderTimelineQuerySet: async () => {
        throw new IpcClientError({ kind: 'internal', message: '세션 없음' });
      },
    });
    const store = await opened(c);
    const q = withAuthors(Q, ['a@x']);
    await store.getState().setTimelineQuery(q);
    expect(store.getState().timeline).toMatchObject({
      query: q,
      loadState: 'error',
      error: '세션 없음',
    });
  });
});

describe('저장소 범위 (W17, folderTimelineScopeSet)', () => {
  it('범위 판정 도우미: 정보의 범위, 선택이 남는지', () => {
    expect(scopeOfInfo(info())).toEqual([]);
    expect(scopeOfInfo(info([WEB]))).toEqual([WEB]);
    expect(selectionInScope(null, [API])).toBe(true);
    expect(selectionInScope({ repoPath: WEB, oid: OID }, [])).toBe(true);
    expect(selectionInScope({ repoPath: WEB, oid: OID }, [WEB])).toBe(true);
    expect(selectionInScope({ repoPath: WEB, oid: OID }, [API])).toBe(false);
  });

  it('곧바로 그 범위가 되고, 고른 커밋의 저장소가 범위에 남으면 선택을 두고 빠지면 비운다', async () => {
    const c = client();
    const store = await opened(c);
    store.getState().selectTimelineRow(WEB, OID);
    await tick();
    const p = store.getState().setTimelineScope([WEB]);
    expect(store.getState().timeline.scope).toEqual([WEB]);
    expect(store.getState().timeline.loadState).toBe('loading');
    await p;
    expect(c.folderTimelineScopeSet).toHaveBeenCalledWith(9, [WEB]);
    expect(store.getState().timeline.selected).toEqual({ repoPath: WEB, oid: OID });

    await store.getState().setTimelineScope([API]);
    expect(store.getState().timeline.selected).toBeNull();
    expect(store.getState().timeline.detail).toBeNull();
  });

  it('다시 읽힌 뒤 정보를 받으면 inScope·scoped 가 갱신되고, 코어가 범위를 풀었으면 따라 푼다', async () => {
    const c = client();
    const store = await opened(c);
    await store.getState().setTimelineScope([API, WEB]);
    reloaded(store, 2);
    await tick();
    expect(store.getState().timeline.info?.scoped).toBe(true);
    expect(store.getState().timeline.info?.repos.map((r) => r.inScope)).toEqual([true, true]);
    // 재스캔으로 범위가 풀린 경우: 코어의 정보가 전부를 말한다
    c.folderTimelineInfo.mockResolvedValue(info());
    reloaded(store, 3);
    await tick();
    expect(store.getState().timeline.scope).toEqual([]);
  });

  it('범위를 바꾸는 요청이 도는 동안 받은 정보로는 범위를 덮어쓰지 않는다', async () => {
    const pending = deferred<void>();
    const c = client({ folderTimelineScopeSet: () => pending.promise });
    const store = await opened(c);
    const p = store.getState().setTimelineScope([API]);
    await store.getState().refreshTimelineInfo();
    expect(store.getState().timeline.scope).toEqual([API]);
    pending.resolve();
    await p;
  });

  it('범위 적용 중에는 이전 데이터와 범위가 다름을 알리고, 전체 명시 선택은 전체와 같다', () => {
    expect(timelineScopePending(info(), [API])).toBe(true);
    expect(timelineScopePending(info([API]), [API])).toBe(false);
    expect(timelineScopePending(info(), [API, WEB])).toBe(false);
  });

  it('연속 변경은 요청을 직렬화하고 대기 중 중간 선택을 건너뛰어 마지막 선택을 적용한다', async () => {
    const first = deferred<void>();
    const c = client();
    c.folderTimelineScopeSet.mockImplementationOnce(() => first.promise);
    const store = await opened(c);
    const a = store.getState().setTimelineScope([API]);
    const b = store.getState().setTimelineScope([WEB]);
    const last = store.getState().setTimelineScope([API, WEB]);
    expect(c.folderTimelineScopeSet).toHaveBeenCalledTimes(1);
    expect(store.getState().timeline.scope).toEqual([API, WEB]);
    first.resolve();
    await Promise.all([a, b, last]);
    expect(c.folderTimelineScopeSet.mock.calls.map((call) => call[1])).toEqual([[API], [API, WEB]]);
    expect(store.getState().timeline.scope).toEqual([API, WEB]);
  });

  it('이전 범위에서 시작한 정보 응답과 새 로드 전 정보가 최신 체크를 덮어쓰지 않는다', async () => {
    const old = deferred<TimelineInfo>();
    const c = client();
    const store = await opened(c);
    c.folderTimelineInfo.mockImplementationOnce(() => old.promise);
    const refresh = store.getState().refreshTimelineInfo();
    await store.getState().setTimelineScope([API]);
    old.resolve(info());
    await refresh;
    expect(store.getState().timeline.scope).toEqual([API]);
    c.folderTimelineInfo.mockResolvedValueOnce(info());
    await store.getState().refreshTimelineInfo();
    expect(store.getState().timeline.scope).toEqual([API]);
    c.folderTimelineInfo.mockResolvedValueOnce(info([API]));
    await store.getState().refreshTimelineInfo();
    expect(timelineScopePending(store.getState().timeline.info, [API])).toBe(false);
  });

  it('옛 범위 요청이 늦게 실패해도 최신 체크는 유지하고 다음 요청을 진행한다', async () => {
    const first = deferred<void>();
    const c = client();
    c.folderTimelineScopeSet.mockImplementationOnce(() => first.promise);
    const store = await opened(c);
    const a = store.getState().setTimelineScope([API]);
    const b = store.getState().setTimelineScope([WEB]);
    first.reject(new Error('old failure'));
    await Promise.all([a, b]);
    expect(store.getState().timeline.scope).toEqual([WEB]);
    expect(c.folderTimelineScopeSet).toHaveBeenLastCalledWith(9, [WEB]);
    expect(store.getState().timeline.error).toBeNull();
  });

  it('마지막 연속 변경이 실패하면 직전 성공 범위로 돌아가며 로딩 상태에 멈추지 않는다', async () => {
    const first = deferred<void>();
    const c = client();
    c.folderTimelineScopeSet.mockImplementationOnce(() => first.promise);
    c.folderTimelineScopeSet.mockRejectedValueOnce(new Error('latest failure'));
    const store = await opened(c);
    const a = store.getState().setTimelineScope([API]);
    const b = store.getState().setTimelineScope([WEB]);
    first.resolve();
    await Promise.all([a, b]);
    expect(store.getState().timeline.scope).toEqual([API]);
    expect(store.getState().timeline.loadState).not.toBe('loading');
    expect(store.getState().timeline.error).toContain('latest failure');
  });

  it('실패하면 이전 범위로 되돌리고 사유를 둔다', async () => {
    const c = client({
      folderTimelineScopeSet: async () => {
        throw new IpcClientError({ kind: 'internal', message: '이 폴더의 저장소가 아닙니다' });
      },
    });
    const store = await opened(c);
    await store.getState().setTimelineScope(['/elsewhere']);
    expect(store.getState().timeline).toMatchObject({
      scope: [],
      loadState: 'complete',
      error: '이 폴더의 저장소가 아닙니다',
    });
  });
});

describe('브랜치 더블클릭의 저장소 범위와 되돌리기 (focusTimelineBranch)', () => {
  const FOCUS = { kind: 'branches' as const, names: ['feature/x', 'main', 'origin/main'] };
  const scope = (store: Awaited<ReturnType<typeof opened>>) => store.getState().timeline.scope;
  const revs = (store: Awaited<ReturnType<typeof opened>>) => store.getState().timeline.query.revs;

  it('ref 범위와 저장소 범위를 함께 걸고, ref 범위가 다른 것으로 바뀌면 저장소 범위를 걸기 전으로 되돌린다', async () => {
    const c = client();
    const store = await opened(c);
    await store.getState().focusTimelineBranch(FOCUS, [API]);
    expect(revs(store)).toEqual(FOCUS);
    expect(scope(store)).toEqual([API]);
    expect(c.folderTimelineScopeSet).toHaveBeenLastCalledWith(9, [API]);
    expect(c.folderTimelineQuerySet).toHaveBeenLastCalledWith(9, { ...Q, revs: FOCUS });
    // 다른 branch 클릭: 걸기 전(전부)으로
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'solo', name: 'main' } });
    expect(scope(store)).toEqual([]);
    expect(c.folderTimelineScopeSet).toHaveBeenLastCalledWith(9, []);
  });

  it('걸기 전의 저장소 범위가 있었으면 그 범위로 되돌린다 (branch 필터 해제 = 전체 범위)', async () => {
    const c = client();
    const store = await opened(c);
    await store.getState().setTimelineScope([WEB]);
    await store.getState().focusTimelineBranch(FOCUS, [API]);
    expect(scope(store)).toEqual([API]);
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'all' } });
    expect(scope(store)).toEqual([WEB]);
  });

  it('ref 범위가 그대로인 다른 필터 변경(텍스트 등)에서는 되돌리지 않는다', async () => {
    const c = client();
    const store = await opened(c);
    await store.getState().focusTimelineBranch(FOCUS, [API]);
    await store
      .getState()
      .setTimelineQuery(
        withText({ ...Q, revs: FOCUS }, { pattern: 'fix', regex: false, matchCase: false }),
      );
    expect(scope(store)).toEqual([API]);
    // 그 뒤 ref 범위가 바뀌면 그때 되돌린다
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'head' } });
    expect(scope(store)).toEqual([]);
  });

  it('그 사이 사용자가 저장소 범위를 바꿨으면 그 값을 존중해 되돌리지 않는다', async () => {
    const c = client();
    const store = await opened(c);
    await store.getState().focusTimelineBranch(FOCUS, [API]);
    await store.getState().setTimelineScope([API, WEB]);
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'all' } });
    expect(scope(store)).toEqual([API, WEB]);
  });

  it('더블클릭이 이어지면 처음 걸기 전의 범위를 기억하고, 한 번만 되돌린다', async () => {
    const c = client();
    const store = await opened(c);
    await store.getState().setTimelineScope([WEB]);
    await store.getState().focusTimelineBranch(FOCUS, [API]);
    const other = { kind: 'branches' as const, names: ['hotfix', 'main'] };
    await store.getState().focusTimelineBranch(other, [API, WEB]);
    expect(scope(store)).toEqual([API, WEB]);
    expect(revs(store)).toEqual(other);
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'solo', name: 'main' } });
    expect(scope(store)).toEqual([WEB]);
    // 기억은 한 번 쓰면 사라진다: 다음 ref 범위 변경은 저장소 범위를 건드리지 않는다
    await store.getState().setTimelineScope([API]);
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'all' } });
    expect(scope(store)).toEqual([API]);
  });

  it('좁히지 않는 더블클릭(모든 저장소에 있는 branch)은 저장소 범위 요청을 보내지 않고, 되돌릴 때도 보내지 않는다', async () => {
    const c = client();
    const store = await opened(c);
    const calls = c.folderTimelineScopeSet.mock.calls.length;
    await store.getState().focusTimelineBranch(FOCUS, []);
    await store.getState().setTimelineQuery({ ...Q, revs: { kind: 'all' } });
    expect(c.folderTimelineScopeSet.mock.calls.length).toBe(calls);
    expect(scope(store)).toEqual([]);
  });
});

describe('작성자 후보 (드롭다운을 열 때 읽기)', () => {
  it('처음 열 때 읽고, 읽은 뒤에는 다시 읽지 않으며, 다시 시도(force)는 다시 읽는다', async () => {
    const c = client();
    const store = await opened(c);
    expect(store.getState().timeline.authors.state).toBe('idle');
    store.getState().loadTimelineAuthors(false);
    expect(store.getState().timeline.authors.state).toBe('loading');
    await tick();
    expect(store.getState().timeline.authors).toEqual({
      state: 'ready',
      list: AUTHORS,
      error: null,
    });
    store.getState().loadTimelineAuthors(false);
    expect(c.folderTimelineAuthors).toHaveBeenCalledTimes(1);
    store.getState().loadTimelineAuthors(true);
    await tick();
    expect(c.folderTimelineAuthors).toHaveBeenCalledTimes(2);
  });

  it('최신 요청의 응답만 반영한다', async () => {
    const slow = deferred<AuthorList>();
    const c = client();
    c.folderTimelineAuthors.mockImplementationOnce(() => slow.promise);
    const store = await opened(c);
    store.getState().loadTimelineAuthors(false);
    const newer: AuthorList = { ...AUTHORS, timedOut: true };
    c.folderTimelineAuthors.mockResolvedValueOnce(newer);
    store.getState().loadTimelineAuthors(true);
    await tick();
    slow.resolve(AUTHORS);
    await tick();
    expect(store.getState().timeline.authors.list).toBe(newer);
    // 시간 초과는 오류가 아니라 결과의 표시다
    expect(store.getState().timeline.authors.state).toBe('ready');
  });

  it('범위가 바뀌면 낡은 것으로 보고(읽는 중이던 응답은 버린다) 다음에 열 때 다시 읽는다', async () => {
    const slow = deferred<AuthorList>();
    const c = client();
    c.folderTimelineAuthors.mockImplementationOnce(() => slow.promise);
    const store = await opened(c);
    store.getState().loadTimelineAuthors(false);
    await store.getState().setTimelineScope([WEB]);
    expect(store.getState().timeline.authors.state).toBe('idle');
    slow.resolve(AUTHORS);
    await tick();
    expect(store.getState().timeline.authors.state).toBe('idle');
    store.getState().loadTimelineAuthors(false);
    await tick();
    expect(c.folderTimelineAuthors).toHaveBeenCalledTimes(2);
    expect(store.getState().timeline.authors.state).toBe('ready');
    // ref 가 바뀌어도 낡은 것으로 본다 (새 커밋)
    store.getState().applyEvent({ type: 'folderChanged', session: 9, refs: true, repo: WEB });
    expect(store.getState().timeline.authors.state).toBe('idle');
    // 이름 표시용 목록은 남긴다
    expect(store.getState().timeline.authors.list).toBe(AUTHORS);
  });

  it('실패하면 오류 상태와 사유', async () => {
    const c = client({
      folderTimelineAuthors: async () => {
        throw new IpcClientError({ kind: 'internal', message: 'git 실패' });
      },
    });
    const store = await opened(c);
    store.getState().loadTimelineAuthors(false);
    await tick();
    expect(store.getState().timeline.authors).toMatchObject({ state: 'error', error: 'git 실패' });
  });
});

describe('질의 변경 뒤 보던 위치 (LG-10)와 목록 모드', () => {
  const ANCHOR = { oid: OID, repo: 1, row: 240, offset: 6 };

  it('같은 질의로 다시 읽히면 기준을 다시 찾지 않고 목록 모드도 그대로다', async () => {
    const c = client();
    const store = await opened(c);
    store.getState().rememberTimelineAnchor(ANCHOR);
    reloaded(store, 2);
    await tick();
    expect(c.folderTimelineFindRow).not.toHaveBeenCalled();
    expect(store.getState().timeline.listMode).toBe(false);
    expect(store.getState().timelineAnchor()).toEqual(ANCHOR);
  });

  it('목록 모드로 바뀐 데이터가 오면 기준을 새 결과에서 찾은 뒤에 모드를 바꾼다 (뷰가 다시 마운트돼 그 행에서 시작)', async () => {
    const find = deferred<number | null>();
    const c = client();
    c.folderTimelineFindRow.mockImplementationOnce(() => find.promise);
    const store = await opened(c);
    store.getState().rememberTimelineAnchor(ANCHOR);
    await store
      .getState()
      .setTimelineQuery(withText(Q, { pattern: 'fix', regex: false, matchCase: false }));
    reloaded(store, 2);
    expect(c.folderTimelineFindRow).toHaveBeenCalledWith(9, 1, OID);
    expect(store.getState().timeline.listMode).toBe(false);
    find.resolve(3);
    await tick();
    expect(store.getState().timeline.listMode).toBe(true);
    expect(store.getState().timelineAnchor()).toEqual({ ...ANCHOR, row: 3 });
    expect(store.getState().timeline.scrollReset).toBe(0);
  });

  it('보던 커밋이 새 결과에 없으면 기준을 버리고 맨 위로 가게 한다', async () => {
    const c = client({ folderTimelineFindRow: async () => null });
    const store = await opened(c);
    store.getState().rememberTimelineAnchor(ANCHOR);
    // 날짜만: 목록 모드가 아니다 (같은 뷰가 남는다)
    await store.getState().setTimelineQuery(withDates(Q, { since: 1, until: 2 }));
    reloaded(store, 2);
    await tick();
    expect(store.getState().timeline.listMode).toBe(false);
    expect(store.getState().timelineAnchor()).toBeNull();
    expect(store.getState().timeline.scrollReset).toBe(1);
  });

  it('범위를 바꾼 뒤의 데이터도 기준을 다시 찾는다', async () => {
    const c = client();
    const store = await opened(c);
    store.getState().rememberTimelineAnchor(ANCHOR);
    await store.getState().setTimelineScope([WEB]);
    reloaded(store, 2);
    await tick();
    expect(c.folderTimelineFindRow).toHaveBeenCalledTimes(1);
    expect(store.getState().timelineAnchor()?.row).toBe(7);
  });
});

describe('보기 옵션의 레이아웃 설정', () => {
  it('긴 엣지 접기를 바꾸면 코어에 보내고, 실패하면 되돌린다', async () => {
    const c = client();
    const store = await opened(c);
    expect(store.getState().timeline.prefs).toEqual(DEFAULT_TIMELINE_PREFS);
    const next = { ...DEFAULT_TIMELINE_PREFS, collapseLongEdges: false };
    await store.getState().setTimelinePrefs(next);
    expect(c.folderTimelinePrefsSet).toHaveBeenCalledWith(9, next);
    expect(store.getState().timeline.prefs).toEqual(next);
    c.folderTimelinePrefsSet.mockRejectedValueOnce(
      new IpcClientError({ kind: 'internal', message: 'x' }),
    );
    await store.getState().setTimelinePrefs(DEFAULT_TIMELINE_PREFS);
    expect(store.getState().timeline.prefs).toEqual(next);
  });

  it('다시 읽기는 읽는 중으로 보인다 (코어는 다시 읽기에 시작 이벤트를 보내지 않는다)', async () => {
    const c = client();
    const store = await opened(c);
    const p = store.getState().reloadTimeline();
    expect(store.getState().timeline.loadState).toBe('loading');
    await p;
    reloaded(store, 2);
    expect(store.getState().timeline.loadState).toBe('complete');
  });
});
