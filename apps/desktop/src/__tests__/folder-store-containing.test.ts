import {
  type ContainingRefs,
  createNullClient,
  type FolderBranches,
  type IpcClient,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTAINING_DEBOUNCE_MS } from '../store/containing-loader';
import { changedBranchRepos, createFolderStore } from '../store/folder-store';

const FOLDER_ID = 61;
const ROOT = '/f';
const API = `${ROOT}/api`;
const WEB = `${ROOT}/web`;
const OID = 'a'.repeat(40);

/** 브랜치 목록: 저장소마다 HEAD 와 브랜치 하나 */
function branches(webBehind: number, apiHead = 'b'.repeat(40)): FolderBranches {
  const head = (oid: string) => ({ state: 'attached' as const, branch: 'main', oid });
  return {
    repos: [
      { path: API, name: 'api', color: 0, head: head(apiHead), error: null },
      { path: WEB, name: 'web', color: 1, head: head('c'.repeat(40)), error: null },
    ],
    branches: [
      {
        name: 'main',
        remote: false,
        remoteName: null,
        repos: [
          {
            path: API,
            color: 0,
            current: true,
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            gone: false,
          },
          {
            path: WEB,
            color: 1,
            current: true,
            upstream: 'origin/main',
            ahead: 0,
            behind: webBehind,
            gone: false,
          },
        ],
      },
    ],
  };
}

const READY: ContainingRefs = { timedOut: false, head: true, branches: [] };

/** 타이머를 옮기고 응답을 비운다 */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('changedBranchRepos (포함 branch 무효화 기준)', () => {
  it('처음 읽으면 없다. HEAD·추적 수치·브랜치가 바뀐 저장소만 나온다', () => {
    expect(changedBranchRepos(null, branches(0))).toEqual([]);
    expect(changedBranchRepos(branches(0), branches(0))).toEqual([]);
    expect(changedBranchRepos(branches(0), branches(3))).toEqual([WEB]);
    expect(changedBranchRepos(branches(0), branches(0, 'd'.repeat(40)))).toEqual([API]);
    const gone = branches(0);
    gone.branches = [];
    expect(changedBranchRepos(branches(0), gone).sort()).toEqual([API, WEB]);
  });
});

describe('폴더 스토어의 포함 branch 무효화 (CD-03)', () => {
  /** 상세 칸이 WEB 의 커밋을 보이고 있는 스토어 */
  async function setup() {
    let list = branches(0);
    const contains = vi.fn<IpcClient['folderCommitContainingRefs']>(async () => READY);
    const client: IpcClient = {
      ...createNullClient(),
      folderSummaries: async () => [],
      folderBranches: async () => list,
      folderRescan: async () => [],
      folderCommitContainingRefs: contains,
    };
    const store = createFolderStore(
      {
        session: FOLDER_ID,
        path: ROOT,
        repos: [API, WEB].map((path) => ({ path, kind: 'standalone' as const })),
      },
      client,
    );
    await advance(0);
    store.getState().showContaining({ repoPath: WEB, oid: OID });
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(contains).toHaveBeenCalledTimes(1);
    expect(store.getState().timeline.containing).toEqual({
      of: { repoPath: WEB, oid: OID },
      state: 'ready',
      refs: READY,
    });
    const setList = (next: FolderBranches) => {
      list = next;
    };
    return { store, contains, setList };
  }

  it('전체 갱신에서 그 저장소의 브랜치 상태가 달라지면 다시 읽고, 같거나 다른 저장소만 달라지면 그대로다', async () => {
    const { store, contains, setList } = await setup();
    await store.getState().refresh();
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(contains).toHaveBeenCalledTimes(1);
    setList(branches(0, 'd'.repeat(40)));
    await store.getState().refresh();
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(contains).toHaveBeenCalledTimes(1);
    setList(branches(5, 'd'.repeat(40)));
    await store.getState().refresh();
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(contains).toHaveBeenCalledTimes(2);
  });

  it('재스캔(저장소 집합 변경)이면 다시 읽는다', async () => {
    const { store, contains } = await setup();
    store.getState().applyEvent({ type: 'folderRescanned', session: FOLDER_ID, repos: [] });
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(contains).toHaveBeenCalledTimes(2);
  });

  it('어느 저장소인지 모르는 ref 변경은 전부 무효화한다', async () => {
    const { store, contains } = await setup();
    store
      .getState()
      .applyEvent({ type: 'folderChanged', session: FOLDER_ID, refs: true, repo: null });
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(contains).toHaveBeenCalledTimes(2);
  });

  it('폴더를 닫으면 예약한 읽기를 거둔다', async () => {
    const { store, contains } = await setup();
    store
      .getState()
      .applyEvent({ type: 'folderChanged', session: FOLDER_ID, refs: true, repo: WEB });
    store.getState().dispose();
    await advance(CONTAINING_DEBOUNCE_MS * 2);
    expect(contains).toHaveBeenCalledTimes(1);
  });
});
