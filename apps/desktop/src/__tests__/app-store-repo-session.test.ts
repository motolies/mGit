import { createMockClient, type RepoOpened, type SessionEvent, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import {
  clearSessionRegistry,
  getFolderStore,
  getSessionCache,
  getSessionStore,
  getWorkspaceStore,
} from '../store/session-registry';
import type { SessionState } from '../store/session-store';
import { fileViewDoc } from '../store/workspace-store';

// 목 폴더 장면 (`packages/ipc/src/mock/mock-workspace.ts`): 코어의 가벼운 세션 계약을 흉내 낸다 — 폴더당 3개,
// 상한이면 lightSessionLimit(잡은 목록과 함께), 탭으로 열면 같은 id 로 승격, 폴더 닫기·탭 닫기의 정리
const FOLDER = '/mock/acme-platform';
const repo = (name: string) => `${FOLDER}/${name}`;
const API = repo('api-gateway');
const AUTH = repo('auth-service');
const BILLING = repo('billing-service');
const DESIGN = repo('design-system');
const WEB = repo('web-console');
const FILE = 'src/main/java/com/acme/auth/login/LoginController.java';

/** 대기 중인 프라미스·타이머를 비운다 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 아무것도 하지 않는 세션 동작 */
const noop = () => {};

/** 목 폴더 장면으로 앱 스토어를 만들고 폴더 탭을 연다. 저장소 세션 IPC 를 기록한다 */
async function setup() {
  const client = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const spies = {
    open: vi.spyOn(client, 'folderOpenRepoSession'),
    release: vi.spyOn(client, 'folderReleaseRepoSession'),
    closeFolder: vi.spyOn(client, 'closeFolder'),
    closeRepo: vi.spyOn(client, 'closeRepo'),
    summaries: vi.spyOn(client, 'folderSummaries'),
  };
  const store = createAppStore({ client, pickDirectory: async () => null });
  await store.getState().openFolderAt(FOLDER);
  const folder = store.getState().activeSessionId as SessionId;
  await flush();
  const ws = () => {
    const w = getWorkspaceStore(folder);
    if (!w) {
      throw new Error('워크스페이스 없음');
    }
    return w.getState();
  };
  /** 그 저장소의 장부 항목 */
  const entry = (path: string) => store.getState().repoSessions[folder]?.[path];
  /** 그 저장소의 세션 기능을 부른다 (시각을 정해 LRU 를 결정적으로) */
  const use = async (path: string, at: number, run: (st: SessionState) => void = noop) => {
    vi.setSystemTime(at);
    return store.getState().withRepoSession(folder, path, run);
  };
  return { client, spies, store, folder, ws, entry, use };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  (globalThis as { __mgitMockCalls?: Record<string, number> }).__mgitMockCalls = {};
});

afterEach(() => {
  vi.useRealTimers();
  clearSessionRegistry();
});

describe('저장소 세션 장부: 열기·재사용 (W13)', () => {
  it('세션은 처음 요청할 때만 열린다: 활성 저장소 변경·파일 보기·커밋 상세로는 0회', async () => {
    const { spies, store, folder, ws } = await setup();
    ws().setActiveRepo(API);
    ws().setActiveRepo(AUTH);
    ws().openDoc(
      fileViewDoc({ path: 'api-gateway/x.ts', name: 'x.ts', repoPath: API, repoName: 'api' }),
      'preview',
    );
    const f = getFolderStore(folder)?.getState();
    f?.selectTimelineRow(API, 'deadbeef');
    await f?.fileTree.getState().readFile('api-gateway/x.ts');
    await flush();
    expect(spies.open).not.toHaveBeenCalled();
    expect(store.getState().repoSessions).toEqual({});
  });

  it('처음 요청하면 열고(가벼운 세션, 그 저장소가 활성 저장소), 다시 요청하면 재사용한다', async () => {
    const { spies, store, folder, ws, entry, use } = await setup();
    ws().setActiveRepo(AUTH);
    const opened: SessionState[] = [];
    expect(await use(API, 1_000, (st) => opened.push(st))).toBe(true);
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(spies.open).toHaveBeenCalledWith(folder, API, expect.any(Function));
    expect(ws().activeRepo).toBe(API);
    const first = entry(API);
    expect(first).toMatchObject({ held: true, usedAt: 1_000 });
    const session = getSessionStore(first?.session ?? -1);
    expect(session?.getState().profile).toBe('light');
    expect(opened[0]?.id).toBe(first?.session);
    expect(store.getState().repoSessionOpening).toEqual({});

    expect(await use(API, 2_000)).toBe(true);
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(entry(API)).toMatchObject({ session: first?.session, usedAt: 2_000 });
    expect(getSessionStore(first?.session ?? -1)).toBe(session);
  });

  it('같은 저장소를 동시에 두 번 요청해도 한 번만 열고 스토어는 하나다', async () => {
    const { spies, entry, store, folder } = await setup();
    const [a, b] = await Promise.all([
      store.getState().withRepoSession(folder, API, noop),
      store.getState().withRepoSession(folder, API, noop),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(entry(API)?.held).toBe(true);
  });

  it('여는 동안 "여는 중" 이 그 폴더에 표시되고 활성 저장소가 잠긴다', async () => {
    const { client, store, folder, ws } = await setup();
    let release: () => void = () => {};
    const original = client.folderOpenRepoSession;
    client.folderOpenRepoSession = (...args) =>
      new Promise<RepoOpened>((resolve, reject) => {
        release = () => void original(...args).then(resolve, reject);
      });
    const pending = store.getState().withRepoSession(folder, API, noop);
    await flush();
    expect(store.getState().repoSessionOpening).toEqual({ [folder]: API });
    ws().setActiveRepo(AUTH);
    expect(ws().activeRepo).toBe(API);
    release();
    expect(await pending).toBe(true);
    expect(store.getState().repoSessionOpening).toEqual({});
    ws().setActiveRepo(AUTH);
    expect(ws().activeRepo).toBe(AUTH);
  });

  it('열지 못하면 사유를 알리고 장부에 남기지 않는다 (요약에 실패한 저장소)', async () => {
    const { store, folder, entry } = await setup();
    expect(await store.getState().withRepoSession(folder, repo('infra-scripts'), noop)).toBe(false);
    expect(entry(repo('infra-scripts'))).toBeUndefined();
    const toast = store.getState().toasts.at(-1);
    expect(toast?.kind).toBe('error');
    expect(toast?.title).toBe(S.repoSession.openFailed('infra-scripts'));
  });
});

describe('저장소 세션 장부: 상한과 LRU (W13, PF-05)', () => {
  it('4번째 저장소에서 가장 오래 안 쓴 한가한 세션을 놓고 연다', async () => {
    const { spies, entry, use } = await setup();
    await use(API, 1_000);
    await use(AUTH, 2_000);
    await use(BILLING, 3_000);
    // api 를 다시 써서 가장 오래 안 쓴 것은 auth 가 된다
    await use(API, 4_000);
    const auth = entry(AUTH)?.session ?? -1;
    expect(await use(DESIGN, 5_000)).toBe(true);
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(spies.release).toHaveBeenCalledWith(expect.any(Number), auth);
    expect(entry(AUTH)).toBeUndefined();
    expect(getSessionStore(auth)).toBeUndefined();
    expect(entry(API)).toBeDefined();
    expect(entry(BILLING)).toBeDefined();
    expect(entry(DESIGN)?.held).toBe(true);

    // 놓은 저장소를 다시 요청하면 새로 연다 (새 id)
    await use(AUTH, 6_000);
    expect(entry(AUTH)?.session).not.toBe(auth);
  });

  it('바쁜 세션(작업·대화상자)은 가장 오래됐어도 놓지 않고 그다음 것을 놓는다', async () => {
    const { spies, entry, use } = await setup();
    await use(API, 1_000);
    await use(AUTH, 2_000);
    await use(BILLING, 3_000);
    // 가장 오래된 api 에 도는 작업이 있다 (활성 저장소는 billing 이라 전환 잠금과는 무관하다)
    getSessionStore(entry(API)?.session ?? -1)?.setState({ busy: true });
    const auth = entry(AUTH)?.session ?? -1;
    await use(DESIGN, 4_000);
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(spies.release).toHaveBeenCalledWith(expect.any(Number), auth);
    expect(entry(API)).toBeDefined();
    expect(entry(AUTH)).toBeUndefined();
  });

  it('잡은 세션이 모두 바쁘면 열지 않고 이유를 알린다', async () => {
    const { spies, store, ws, entry, use } = await setup();
    await use(API, 1_000);
    await use(AUTH, 2_000);
    await use(BILLING, 3_000);
    for (const path of [API, AUTH, BILLING]) {
      getSessionStore(entry(path)?.session ?? -1)?.setState({ busy: true });
    }
    // 활성 저장소(billing)의 세션이 바쁘면 다른 저장소 요청은 전환 잠금에서 먼저 막힌다. 상한 판정만 보려고 활성
    // 저장소를 비운다 (재스캔으로 목록에서 빠졌을 때와 같은 길)
    ws().retainActiveRepo([]);
    expect(await use(DESIGN, 4_000)).toBe(false);
    expect(spies.open).toHaveBeenCalledTimes(3);
    expect(spies.release).not.toHaveBeenCalled();
    expect(store.getState().toasts.at(-1)?.title).toBe(S.repoSession.limitBusy(3));
    expect(entry(DESIGN)).toBeUndefined();
  });

  it('코어가 lightSessionLimit 이면(장부가 어긋남) 목록으로 장부를 맞추고 한 번만 다시 시도한다', async () => {
    const { client, spies, store, folder, entry, use } = await setup();
    await use(API, 1_000);
    await use(AUTH, 2_000);
    // 프런트 장부 밖에서 잡힌 세션 (기록을 잃은 경우)
    const orphan = await client.folderOpenRepoSession(folder, BILLING, () => {});
    spies.open.mockClear();
    expect(await use(DESIGN, 3_000)).toBe(true);
    // 첫 시도는 상한 오류 → 장부에 없던 잡음을 놓고 → 다시 시도해 열린다
    expect(spies.open).toHaveBeenCalledTimes(2);
    expect(spies.release).toHaveBeenCalledWith(folder, orphan.session);
    expect(entry(DESIGN)?.held).toBe(true);
    expect(entry(API)).toBeDefined();
    expect(entry(AUTH)).toBeDefined();
    expect(store.getState().toasts).toEqual([]);
  });
});

describe('저장소 세션 장부: 승격·빌림·닫기·재스캔 (W13)', () => {
  it('저장소 탭의 세션을 빌리면(alreadyOpen) 스토어를 새로 만들지 않는다. 탭을 닫으면 장부 항목도 지운다', async () => {
    const { spies, store, folder, entry, use } = await setup();
    const tab = (await store.getState().openRepositoryAt(WEB)) as SessionId;
    const tabStore = getSessionStore(tab);
    store.getState().setActiveSession(folder);
    expect(await use(WEB, 1_000)).toBe(true);
    expect(entry(WEB)).toEqual({ session: tab, held: false, usedAt: 1_000 });
    expect(getSessionStore(tab)).toBe(tabStore);
    expect(tabStore?.getState().profile).toBe('full');

    await store.getState().closeSession(tab);
    expect(spies.closeRepo).toHaveBeenCalledWith(tab);
    expect(entry(WEB)).toBeUndefined();
    expect(getSessionStore(tab)).toBeUndefined();
    // 다음에 필요하면 새로 연다
    await use(WEB, 2_000);
    expect(entry(WEB)?.session).not.toBe(tab);
    expect(entry(WEB)?.held).toBe(true);
  });

  it('숨은 세션이 있는 저장소를 탭으로 열면 같은 스토어가 승격된다: 그래프 로드가 그 스토어로 오고 장부는 빌림이 된다', async () => {
    const { store, folder, entry, use } = await setup();
    await use(API, 1_000);
    const light = entry(API)?.session ?? -1;
    const lightStore = getSessionStore(light);
    const lightCache = getSessionCache(light);
    expect(lightStore?.getState().loadState).toBe('opening');

    const id = await store.getState().openRepositoryAt(API, folder);
    expect(id).toBe(light);
    expect(getSessionStore(light)).toBe(lightStore);
    expect(getSessionCache(light)).toBe(lightCache);
    expect(lightStore?.getState().profile).toBe('full');
    // 목은 간격 0 이면 승격하며 그래프 로드를 바로 끝낸다 — 그 이벤트가 이 스토어로 왔다
    expect(lightStore?.getState().loadState).toBe('complete');
    expect(lightStore?.getState().totalRows).toBe(60);
    expect(store.getState().sessions[light]).toMatchObject({ kind: 'repo', parent: folder });
    expect(entry(API)).toMatchObject({ session: light, held: false });

    // 탭을 닫은 뒤 폴더에서 다시 요청하면 새로 연다
    await store.getState().closeSession(light);
    expect(getSessionStore(light)).toBeUndefined();
    store.getState().setActiveSession(folder);
    await use(API, 2_000);
    expect(entry(API)?.session).not.toBe(light);
  });

  it('승격한 세션은 상한에 세지 않는다 (코어가 잡음을 지웠다)', async () => {
    const { spies, store, folder, entry, use } = await setup();
    await use(API, 1_000);
    await store.getState().openRepositoryAt(API, folder);
    store.getState().setActiveSession(folder);
    await use(AUTH, 2_000);
    await use(BILLING, 3_000);
    await use(DESIGN, 4_000);
    expect(spies.release).not.toHaveBeenCalled();
    expect(entry(API)?.held).toBe(false);
    expect([AUTH, BILLING, DESIGN].every((p) => entry(p)?.held)).toBe(true);
  });

  it('폴더 탭을 닫으면 장부를 비우고 그 폴더만 쓰던 스토어를 버린다. 따로 연 탭의 세션은 남는다', async () => {
    const { spies, store, folder, entry, use } = await setup();
    const tab = (await store.getState().openRepositoryAt(WEB)) as SessionId;
    store.getState().setActiveSession(folder);
    await use(API, 1_000);
    await use(AUTH, 2_000);
    await use(WEB, 3_000);
    const ids = [API, AUTH].map((p) => entry(p)?.session ?? -1);
    await store.getState().closeSession(folder);
    expect(spies.closeFolder).toHaveBeenCalledWith(folder);
    expect(store.getState().repoSessions).toEqual({});
    for (const id of ids) {
      expect(getSessionStore(id)).toBeUndefined();
    }
    expect(getSessionStore(tab)).toBeDefined();
    expect(store.getState().sessions[tab]).toBeDefined();
  });

  it('재스캔으로 빠진 저장소의 세션을 놓고 활성 저장소를 비운다 — 폴더 탭이 화면에 없어도', async () => {
    const { client, spies, store, folder, ws, entry, use } = await setup();
    await use(API, 1_000);
    await use(AUTH, 2_000);
    const auth = entry(AUTH)?.session ?? -1;
    expect(ws().activeRepo).toBe(AUTH);
    // 다른 탭을 보고 있는 동안 (폴더 화면의 effect 는 돌지 않는다)
    await store.getState().openRepositoryAt(WEB);
    const repos = (await client.folderRescan(folder)).filter((r) => r.path !== AUTH);
    getFolderStore(folder)
      ?.getState()
      .applyEvent({ type: 'folderRescanned', session: folder, repos });
    await flush();
    expect(ws().activeRepo).toBeNull();
    expect(spies.release).toHaveBeenCalledWith(folder, auth);
    expect(entry(AUTH)).toBeUndefined();
    expect(getSessionStore(auth)).toBeUndefined();
    expect(entry(API)).toBeDefined();
  });
});

describe('활성 저장소 전환 차단과 폴더 화면 갱신 (W13, 계획 5.1)', () => {
  it('범위 세션의 대화상자가 열려 있으면 트리 선택·탭 활성화가 활성 저장소를 옮기지 못한다', async () => {
    const { spies, store, folder, ws, use } = await setup();
    await use(API, 1_000, (st) => void st.openFileHistory(FILE));
    ws().setActiveRepo(AUTH);
    expect(ws().activeRepo).toBe(API);
    // 다른 저장소의 파일 탭을 열어도 탭은 열리고 활성 저장소는 그대로다
    ws().openDoc(
      fileViewDoc({ path: 'auth-service/a.ts', name: 'a.ts', repoPath: AUTH, repoName: 'auth' }),
      'pinned',
    );
    expect(ws().activeDocId).toBe('file:auth-service/a.ts');
    expect(ws().activeRepo).toBe(API);
    // 다른 저장소의 세션 기능 요청도 거부하고 알린다
    expect(await use(AUTH, 2_000)).toBe(false);
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(store.getState().toasts.at(-1)?.title).toBe(S.repoSession.busyElsewhere('api-gateway'));

    // 대화상자를 닫으면 풀린다
    const session = store.getState().repoSessions[folder]?.[API]?.session ?? -1;
    getSessionStore(session)?.getState().closeFileHistory();
    ws().setActiveRepo(AUTH);
    expect(ws().activeRepo).toBe(AUTH);
  });

  it('숨은 세션의 상태 변경이 오면 그 저장소의 폴더 요약·변경을 디바운스 뒤 다시 읽는다', async () => {
    const { spies, folder, entry, use } = await setup();
    await use(API, 1_000);
    const session = entry(API)?.session ?? -1;
    const onEvent = spies.open.mock.calls[0]?.[2] as (e: SessionEvent) => void;
    spies.summaries.mockClear();
    const status = getSessionStore(session)?.getState().status;
    if (!status) {
      throw new Error('세션 상태 없음');
    }
    onEvent({ type: 'statusChanged', session, status: { ...status, stashCount: 1 }, op: null });
    onEvent({ type: 'statusChanged', session, status, op: null });
    await new Promise((r) => setTimeout(r, 600));
    expect(spies.summaries).toHaveBeenCalledTimes(1);
    expect(spies.summaries).toHaveBeenCalledWith(folder, [API]);
    // 세션 스토어에도 그대로 간다
    expect(getSessionStore(session)?.getState().status).toEqual(status);
  });

  it('가벼운 세션으로 히스토리·blame·외부 도구를 써도 코어(목)가 graphUnavailable 로 거부한 일이 없다', async () => {
    const { store, folder, entry, use } = await setup();
    await use(API, 1_000, (st) => void st.openFileHistory(FILE));
    const st = () => getSessionStore(entry(API)?.session ?? -1)?.getState();
    await flush();
    st()?.closeFileHistory();
    await use(API, 2_000, (s) => void s.openBlame(FILE, null));
    await flush();
    st()?.closeBlame();
    await use(
      API,
      3_000,
      (s) => void s.openDifftool({ kind: 'workTree', path: FILE, staged: false }),
    );
    await flush();
    const calls = (globalThis as { __mgitMockCalls?: Record<string, number> }).__mgitMockCalls;
    expect(calls?.graphUnavailable ?? 0).toBe(0);
    expect(calls?.fileHistory).toBe(1);
    expect(calls?.blame).toBe(1);
    expect(calls?.openDifftool).toBe(1);
    expect(st()?.actionError).toBeNull();
    expect(store.getState().repoSessions[folder]?.[API]?.held).toBe(true);
  });
});
