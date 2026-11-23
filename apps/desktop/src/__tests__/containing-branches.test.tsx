import {
  type CommitDetail,
  type ContainingRefs,
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  IpcClientError,
  type RefLabel,
  type RepoOpened,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitDetail as SessionCommitDetail } from '../features/detail/CommitDetail';
import { CommitDetailView } from '../features/detail/CommitDetailView';
import type { ContainingLine } from '../features/detail/ContainingBranches';
import { FolderCommitPane } from '../features/folder/FolderCommitPane';
import { useAppStore } from '../store';
import { CONTAINING_DEBOUNCE_MS } from '../store/containing-loader';
import { createFolderStore, type FolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  registerFolder,
  registerSession,
} from '../store/session-registry';
import { createSessionStore, type SessionStore } from '../store/session-store';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

const OID = 'a1b2c3d4'.padEnd(40, '1');
const PARENT = 'c3d4e5f6'.padEnd(40, '3');
const FOLDER_ID = 51;
const SESSION_ID = 52;
const ROOT = '/f';
const API = `${ROOT}/api`;
const WEB = `${ROOT}/web`;

/** n 번째 커밋 oid */
const oidAt = (n: number) => `${n}`.padStart(8, '0').padEnd(40, 'e');

/** 커밋 상세 응답 */
function detailOf(oid: string, partial: Partial<CommitDetail> = {}): CommitDetail {
  return {
    oid,
    parents: [PARENT],
    children: [],
    row: 2,
    authorName: 'Jamie Park',
    authorEmail: 'jamie@acme.dev',
    authorTime: 1761632400,
    committerName: 'Jamie Park',
    committerEmail: 'jamie@acme.dev',
    committerTime: 1761632400,
    message: `${oid.slice(0, 8)} 의 제목`,
    refs: [],
    files: [],
    ...partial,
  };
}

/** 포함 branch 결과. `origin/` 으로 시작하면 원격, `*` 로 시작하면 현재 브랜치 */
function containing(head: boolean, ...names: string[]): ContainingRefs {
  return {
    timedOut: false,
    head,
    branches: names.map((raw) => {
      const current = raw.startsWith('*');
      const shortName = current ? raw.slice(1) : raw;
      const remote = shortName.startsWith('origin/');
      return {
        name: `refs/${remote ? 'remotes' : 'heads'}/${shortName}`,
        shortName,
        remote,
        current,
      };
    }),
  };
}

const TIMED_OUT: ContainingRefs = { timedOut: true, head: false, branches: [] };

/** 미뤄 둔 응답 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 줄의 이름들 (쉼표 없이) */
function names(): string[] {
  const list = screen.queryByRole('list', { name: S.detail.containingList });
  if (!list) {
    return [];
  }
  return within(list)
    .queryAllByRole('listitem')
    .filter((li) => li.getAttribute('data-tone') !== null)
    .map((li) => (li.textContent ?? '').replace(/,$/, ''));
}

/** 줄 요소 */
const line = () => document.querySelector<HTMLElement>('[data-state]');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('포함 branch 줄 (CD-03, 뷰)', () => {
  /** 상세 뷰에 줄 하나를 그린다 */
  function view(containingLine: ContainingLine | undefined, refs: RefLabel[] = []) {
    return render(
      <CommitDetailView
        detail={detailOf(OID, { refs })}
        isHead={false}
        containing={containingLine}
      />,
    );
  }

  it('읽는 중: ref 라벨 줄 다음에 한 줄을 차지한다', () => {
    const main = {
      fullName: 'refs/heads/main',
      shortName: 'main',
      kind: { kind: 'localBranch' },
      isCurrent: true,
    } as RefLabel;
    view({ load: { state: 'loading' } }, [main]);
    const el = line() as HTMLElement;
    expect(el.getAttribute('data-state')).toBe('loading');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.textContent).toBe(S.detail.containingLoading);
    const refs = document.querySelector('[data-wrap="true"]') as HTMLElement;
    expect(refs.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('주지 않으면 그리지 않는다 (W8 화면 그대로)', () => {
    view(undefined);
    expect(line()).toBeNull();
  });

  it('완료: `branch N개에 포함:` 과 HEAD 를 맨 앞에, 로컬·원격을 아이콘 색(종류)으로 가려 늘어놓는다', () => {
    view({
      load: { state: 'ready', refs: containing(true, '*development', 'origin/development') },
    });
    expect(line()?.textContent).toContain(S.detail.containing(3));
    expect(names()).toEqual(['HEAD', 'development', 'origin/development']);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-tone'))).toEqual(['head', 'local', 'remote']);
    expect(items[1]?.getAttribute('title')).toBe('refs/heads/development');
    // 쉼표는 마지막 이름에 붙지 않는다
    expect(items.map((li) => li.textContent)).toEqual([
      'HEAD,',
      'development,',
      'origin/development',
    ]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('0개: 어느 branch 에도 없다고 쓴다', () => {
    view({ load: { state: 'ready', refs: containing(false) } });
    expect(line()?.textContent).toBe(S.detail.containingNone);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('10개를 넘으면 앞의 10개만 보이고 `외 N개` 로 펼치며, 다시 접을 수 있다', () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `origin/feature/${String(i).padStart(2, '0')}`,
    );
    view({ load: { state: 'ready', refs: containing(true, ...many) } });
    expect(line()?.textContent).toContain(S.detail.containing(13));
    expect(names()).toHaveLength(10);
    expect(names()[0]).toBe('HEAD');
    const more = screen.getByRole('button', { name: S.detail.containingMore(3) });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    // 접혀 있으면 열 번째 이름 뒤에도 쉼표가 붙어 `외 N개` 로 이어진다
    expect(within(screen.getByRole('list')).getAllByRole('listitem')[9]?.textContent).toMatch(/,$/);
    fireEvent.click(more);
    expect(names()).toHaveLength(13);
    expect(names()[12]).toBe('origin/feature/11');
    const less = screen.getByRole('button', { name: S.detail.containingLess });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(names()).toHaveLength(10);
  });

  it('정확히 10개면 접지 않는다', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `b${i}`);
    view({ load: { state: 'ready', refs: containing(true, ...nine) } });
    expect(names()).toHaveLength(10);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('커밋이 바뀌면 펼친 상태를 새로 시작한다', () => {
    const many = Array.from({ length: 11 }, (_, i) => `b${String(i).padStart(2, '0')}`);
    const ready: ContainingLine = { load: { state: 'ready', refs: containing(false, ...many) } };
    const { rerender } = view(ready);
    fireEvent.click(screen.getByRole('button', { name: S.detail.containingMore(1) }));
    expect(names()).toHaveLength(11);
    rerender(<CommitDetailView detail={detailOf(oidAt(2))} isHead={false} containing={ready} />);
    expect(names()).toHaveLength(10);
  });

  it('시간 초과·오류: 사유 한 줄과 "다시 시도". 누르면 알린다', () => {
    const onRetry = vi.fn();
    const { rerender } = view({ load: { state: 'timedOut' }, onRetry });
    expect(line()?.textContent).toContain(S.detail.containingTimedOut);
    fireEvent.click(screen.getByRole('button', { name: S.detail.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <CommitDetailView
        detail={detailOf(OID)}
        isHead={false}
        containing={{ load: { state: 'error', error: 'no such commit' }, onRetry }}
      />,
    );
    expect(line()?.textContent).toContain(S.detail.containingFailed('no such commit'));
    fireEvent.click(screen.getByRole('button', { name: S.detail.retry }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

/** 타이머를 옮기고 그사이의 응답·렌더를 비운다 */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('폴더 상세 칸의 포함 branch (CD-03, 컨테이너·스토어)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    act(() => useAppStore.setState({ sessions: {}, sessionOrder: [], activeSessionId: null }));
    disposeFolder(FOLDER_ID);
    clearSessionRegistry();
  });

  /** 폴더 탭을 활성으로 두고 상세 칸만 그린다 */
  function setup(contains: IpcClient['folderCommitContainingRefs']) {
    const spy = vi.fn(contains);
    const client: IpcClient = {
      ...createNullClient(),
      folderSummaries: async () => [],
      folderCommitDetail: async (_s, _repo, oid) => detailOf(oid),
      folderCommitContainingRefs: spy,
    };
    const store: FolderStore = createFolderStore(
      {
        session: FOLDER_ID,
        path: ROOT,
        repos: [API, WEB].map((path) => ({ path, kind: 'standalone' as const })),
      },
      client,
    );
    registerFolder(FOLDER_ID, store);
    act(() =>
      useAppStore.setState({
        sessions: {
          [FOLDER_ID]: { id: FOLDER_ID, kind: 'folder', path: ROOT, name: 'f', parent: null },
        },
        sessionOrder: [FOLDER_ID],
        activeSessionId: FOLDER_ID,
      }),
    );
    render(<FolderCommitPane onNavigate={() => {}} />);
    /** 로그에서 행을 고른다 */
    const select = (repoPath: string, oid: string) =>
      act(() => store.getState().selectTimelineRow(repoPath, oid));
    return { store, spy, select };
  }

  it('상세가 먼저 뜨고, 디바운스 뒤에 포함 branch 가 뒤따라 채워진다 (HEAD 가 맨 앞)', async () => {
    const { spy, select } = setup(async () => containing(true, '*main', 'origin/main'));
    select(WEB, OID);
    await flush();
    expect(document.body.textContent).toContain(`${OID.slice(0, 8)} 의 제목`);
    expect(line()?.getAttribute('data-state')).toBe('loading');
    expect(spy).not.toHaveBeenCalled();
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledWith(FOLDER_ID, WEB, OID);
    expect(names()).toEqual(['HEAD', 'main', 'origin/main']);
  });

  it('↓ 로 빠르게 훑는 동안은 묻지 않고, 멈춘 마지막 행만 한 번 묻는다', async () => {
    const { spy, select } = setup(async (_s, _r, oid) =>
      containing(false, `on-${oid.slice(0, 8)}`),
    );
    for (let i = 0; i < 8; i += 1) {
      select(i % 2 === 0 ? WEB : API, oidAt(i));
      await flush(40);
    }
    expect(spy).not.toHaveBeenCalled();
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy.mock.calls).toEqual([[FOLDER_ID, API, oidAt(7)]]);
    expect(names()).toEqual([`on-${oidAt(7).slice(0, 8)}`]);
  });

  it('늦게 온 옛 응답은 버린다', async () => {
    const first = deferred<ContainingRefs>();
    const { select } = setup(async (_s, _r, oid) =>
      oid === OID ? first.promise : containing(false, 'second'),
    );
    select(WEB, OID);
    await flush(CONTAINING_DEBOUNCE_MS);
    select(WEB, oidAt(1));
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(names()).toEqual(['second']);
    first.resolve(containing(false, 'first'));
    await flush();
    expect(names()).toEqual(['second']);
  });

  it('같은 커밋은 다시 묻지 않는다: 같은 행을 다시 고르거나, 타임라인이 다시 읽히거나, 들렀다 돌아와도', async () => {
    const { store, spy, select } = setup(async (_s, _r, oid) => containing(false, oid.slice(0, 8)));
    select(WEB, OID);
    await flush(CONTAINING_DEBOUNCE_MS);
    select(WEB, OID);
    act(() =>
      store.getState().applyEvent({
        type: 'graphReloaded',
        session: FOLDER_ID,
        generation: 2,
        rows: 10,
        laneCount: 2,
      }),
    );
    await flush(CONTAINING_DEBOUNCE_MS);
    select(WEB, oidAt(1));
    await flush(CONTAINING_DEBOUNCE_MS);
    select(WEB, OID);
    await flush();
    expect(names()).toEqual([OID.slice(0, 8)]);
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy.mock.calls.map((c) => c[2])).toEqual([OID, oidAt(1)]);
  });

  it('ref 가 바뀌면(그 저장소의 folderChanged) 읽어 둔 것을 버리고 지금 보이는 커밋만 다시 묻는다', async () => {
    let round = 1;
    const { store, spy, select } = setup(async () => containing(false, `round-${round}`));
    select(WEB, oidAt(1));
    await flush(CONTAINING_DEBOUNCE_MS);
    select(WEB, OID);
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    // 다른 저장소의 ref 변경, ref 가 아닌 변경은 상관없다
    act(() =>
      store
        .getState()
        .applyEvent({ type: 'folderChanged', session: FOLDER_ID, refs: true, repo: API }),
    );
    act(() =>
      store
        .getState()
        .applyEvent({ type: 'folderChanged', session: FOLDER_ID, refs: false, repo: WEB }),
    );
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    round = 2;
    act(() =>
      store
        .getState()
        .applyEvent({ type: 'folderChanged', session: FOLDER_ID, refs: true, repo: WEB }),
    );
    expect(line()?.getAttribute('data-state')).toBe('loading');
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy.mock.calls.slice(2).map((c) => c[2])).toEqual([OID]);
    expect(names()).toEqual(['round-2']);
    // 같은 저장소의 다른 커밋도 잊혔다: 다시 고르면 다시 묻는다
    select(WEB, oidAt(1));
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('시간 초과면 사유와 "다시 시도" 를 보이고, 누르면 디바운스 없이 다시 읽는다', async () => {
    let timedOut = true;
    const { spy, select } = setup(async () => (timedOut ? TIMED_OUT : containing(true, '*main')));
    select(WEB, OID);
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(line()?.textContent).toContain(S.detail.containingTimedOut);
    timedOut = false;
    fireEvent.click(screen.getByRole('button', { name: S.detail.retry }));
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(names()).toEqual(['HEAD', 'main']);
  });

  it('커밋을 빠르게 옮겨 앞 요청이 코어에서 cancelled 로 끝나도 줄에 오류가 깜빡이지 않고 마지막 커밋의 결과만 보인다 (W18 ①)', async () => {
    // 코어 흉내: 같은 (폴더) 세션의 새 요청이 오면 아직 답하지 않은 앞 요청을 cancelled 로 끝낸다. 요청마다 1초 뒤에 답한다
    let cancelPrevious: (() => void) | null = null;
    const { spy, select } = setup(
      (_s, _repo, oid) =>
        new Promise<ContainingRefs>((resolve, reject) => {
          cancelPrevious?.();
          let settled = false;
          cancelPrevious = () => {
            if (!settled) {
              settled = true;
              reject(new IpcClientError({ kind: 'cancelled' }));
            }
          };
          setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve(containing(false, `on-${oid.slice(0, 8)}`));
            }
          }, 1_000);
        }),
    );
    const states: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      select(i % 2 === 0 ? WEB : API, oidAt(i));
      await flush(CONTAINING_DEBOUNCE_MS + 50);
      states.push(line()?.getAttribute('data-state') ?? null);
    }
    expect(spy).toHaveBeenCalledTimes(4);
    expect(states).toEqual(['loading', 'loading', 'loading', 'loading']);
    await flush(1_000);
    expect(line()?.getAttribute('data-state')).toBe('ready');
    expect(names()).toEqual([`on-${oidAt(3).slice(0, 8)}`]);
    expect(document.body.textContent).not.toContain(S.error.cancelled);
  });

  it('칸이 내려가면 예약한 읽기를 거둔다', async () => {
    const { spy, select } = setup(async () => containing(false, 'x'));
    select(WEB, OID);
    await flush();
    cleanup();
    await flush(CONTAINING_DEBOUNCE_MS * 2);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('저장소 탭 상세의 포함 branch (CD-03, 컨테이너·세션 스토어)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => useAppStore.setState({ sessions: {}, sessionOrder: [], activeSessionId: null }));
    clearSessionRegistry();
  });

  /** 저장소 탭을 활성으로 두고 상세 패널만 그린다 */
  function setup(contains: IpcClient['commitContainingRefs']) {
    const spy = vi.fn(contains);
    const head = { state: 'attached' as const, branch: 'main', oid: OID };
    const opened: RepoOpened = {
      session: SESSION_ID,
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
    const client: IpcClient = {
      ...createNullClient(),
      commitDetail: async (_s, oid) => detailOf(oid),
      commitContainingRefs: spy,
    };
    const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
    const store: SessionStore = createSessionStore(opened, client, cache);
    registerSession(SESSION_ID, { cache, store });
    act(() =>
      useAppStore.setState({
        sessions: {
          [SESSION_ID]: { id: SESSION_ID, kind: 'repo', path: '/r', name: 'r', parent: null },
        },
        sessionOrder: [SESSION_ID],
        activeSessionId: SESSION_ID,
      }),
    );
    render(<SessionCommitDetail />);
    return { store, spy };
  }

  it('커밋을 고르면 상세 뒤에 같은 줄이 나오고, refsChanged 면 보이는 커밋만 다시 읽는다', async () => {
    let round = 1;
    const { store, spy } = setup(async () => containing(true, '*main', `origin/r${round}`));
    act(() => store.getState().selectCommit(OID));
    await flush();
    expect(line()?.getAttribute('data-state')).toBe('loading');
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledWith(SESSION_ID, OID);
    expect(names()).toEqual(['HEAD', 'main', 'origin/r1']);

    // 다른 커밋을 들렀다 돌아오면 다시 묻지 않는다
    act(() => store.getState().selectCommit(oidAt(1)));
    await flush(CONTAINING_DEBOUNCE_MS);
    act(() => store.getState().selectCommit(OID));
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([OID, oidAt(1)]);

    round = 2;
    act(() =>
      store.getState().applyEvent({
        type: 'refsChanged',
        session: SESSION_ID,
        refs: store.getState().refs,
      }),
    );
    await flush(CONTAINING_DEBOUNCE_MS);
    expect(spy.mock.calls.slice(2).map((c) => c[1])).toEqual([OID]);
    expect(names()).toEqual(['HEAD', 'main', 'origin/r2']);
  });

  it('WIP 를 고르면(상세가 없어지면) 예약한 읽기를 거둔다', async () => {
    const { store, spy } = setup(async () => containing(false, 'x'));
    act(() => store.getState().selectCommit(OID));
    await flush();
    act(() => store.getState().selectWip());
    await flush(CONTAINING_DEBOUNCE_MS * 2);
    expect(spy).not.toHaveBeenCalled();
    expect(store.getState().containing).toBeNull();
  });
});
