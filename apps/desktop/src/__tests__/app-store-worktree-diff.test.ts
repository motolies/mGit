import { createMockClient, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import {
  clearSessionRegistry,
  getSessionStore,
  getWorkspaceStore,
} from '../store/session-registry';
import { worktreeDiffDocId } from '../store/workspace-store';

// 목 폴더 장면 (`packages/ipc/src/mock/mock-workspace.ts`): 가벼운 세션은 폴더당 3개
const FOLDER = '/mock/acme-platform';
const repo = (name: string) => `${FOLDER}/${name}`;
const API = repo('api-gateway');
const AUTH = repo('auth-service');
const BILLING = repo('billing-service');
const DESIGN = repo('design-system');
const WEB = repo('web-console');

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 앱 스토어로 폴더 탭을 열고, 그 저장소의 파일을 작업 트리 diff 탭으로 여는 도우미를 준다 */
async function setup() {
  const client = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const release = vi.spyOn(client, 'folderReleaseRepoSession');
  const open = vi.spyOn(client, 'folderOpenRepoSession');
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
  const session = (path: string) => store.getState().repoSessions[folder]?.[path]?.session ?? -1;
  /** Commit 도구 창이 파일을 여는 것과 같은 길: 세션 슬롯을 채우고 그 저장소의 diff 탭을 보인다 */
  const openDiff = async (path: string, file: string, at: number) => {
    vi.setSystemTime(at);
    const ok = await store.getState().withRepoSession(folder, path, (st) => {
      void st.openFile(file, false);
      ws().revealDoc(worktreeDiffDocId(path));
    });
    await flush();
    return ok;
  };
  return { client, store, folder, ws, session, openDiff, release, open };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  clearSessionRegistry();
});

describe('작업 트리 diff 탭은 장부의 세션 슬롯에서 파생한다 (W14, 계획 5.2)', () => {
  it('파일을 열면 탭이 생기고, 같은 저장소의 다른 파일은 같은 탭의 내용이 바뀌며, 다른 저장소는 탭이 하나 더 생긴다', async () => {
    const { ws, openDiff, open } = await setup();
    await openDiff(WEB, 'apps/console/src/shared/api/orders.ts', 1_000);
    expect(ws().sessionDocs.map((d) => [d.id, d.kind === 'worktreeDiff' && d.path])).toEqual([
      [worktreeDiffDocId(WEB), 'apps/console/src/shared/api/orders.ts'],
    ]);
    expect(ws().activeDocId).toBe(worktreeDiffDocId(WEB));
    expect(ws().activeRepo).toBe(WEB);
    // 저장하는 문서 목록에는 없다
    expect(ws().docs.map((d) => d.id)).toEqual(['overview']);

    await openDiff(WEB, 'apps/console/src/shared/i18n/ko.json', 2_000);
    expect(ws().sessionDocs).toHaveLength(1);
    expect(ws().sessionDocs[0]).toMatchObject({ path: 'apps/console/src/shared/i18n/ko.json' });
    expect(open).toHaveBeenCalledTimes(1);

    await openDiff(AUTH, 'src/main/resources/config/rate-limit.yaml', 3_000);
    expect(ws().sessionDocs.map((d) => d.id)).toEqual([
      worktreeDiffDocId(WEB),
      worktreeDiffDocId(AUTH),
    ]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('탭을 닫으면 활성 저장소와 무관하게 그 문서의 저장소 세션 슬롯이 빈다', async () => {
    const { ws, session, openDiff } = await setup();
    await openDiff(WEB, 'apps/console/src/shared/api/orders.ts', 1_000);
    await openDiff(AUTH, 'src/main/resources/config/rate-limit.yaml', 2_000);
    // 활성 저장소는 auth 다. web 의 탭을 닫는다
    ws().closeDoc(worktreeDiffDocId(WEB));
    expect(getSessionStore(session(WEB))?.getState().selectedFile).toBeNull();
    expect(getSessionStore(session(AUTH))?.getState().selectedFile).not.toBeNull();
    expect(ws().sessionDocs.map((d) => d.id)).toEqual([worktreeDiffDocId(AUTH)]);
  });

  it('보던 탭의 파일이 그 영역에서 사라지면(세션이 슬롯을 비운다) 탭도 사라지고 직전 문서로 돌아간다', async () => {
    const { ws, session, openDiff } = await setup();
    await openDiff(WEB, 'apps/console/src/shared/api/orders.ts', 1_000);
    getSessionStore(session(WEB))?.getState().closeFile();
    expect(ws().sessionDocs).toEqual([]);
    expect(ws().activeDocId).toBe('overview');
  });
});

describe('세션 상한과 작업 트리 diff 탭 (W14)', () => {
  it('네 번째 저장소의 파일을 열면 가장 오래 안 쓴 한가한 세션을 놓고 그 탭이 사라진다. 보이는 탭의 세션은 남는다', async () => {
    const { ws, session, openDiff, release } = await setup();
    await openDiff(API, 'README.md', 1_000);
    await openDiff(AUTH, 'src/main/resources/config/rate-limit.yaml', 2_000);
    await openDiff(BILLING, 'README.md', 3_000);
    // 가장 오래된 api 의 탭을 보고 있다 (보는 것도 쓰는 것이라 사용 시각이 오른다)
    vi.setSystemTime(3_500);
    ws().activateDoc(worktreeDiffDocId(API));
    const auth = session(AUTH);
    await openDiff(DESIGN, 'README.md', 4_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(Number), auth);
    expect(ws().sessionDocs.map((d) => d.id)).toEqual([
      worktreeDiffDocId(API),
      worktreeDiffDocId(BILLING),
      worktreeDiffDocId(DESIGN),
    ]);
  });

  it('보이는 탭의 세션은 사용 시각이 가장 오래돼도 놓지 않는다', async () => {
    const { store, folder, ws, session, openDiff, release } = await setup();
    await openDiff(API, 'README.md', 1_000);
    await openDiff(AUTH, 'src/main/resources/config/rate-limit.yaml', 2_000);
    await openDiff(BILLING, 'README.md', 3_000);
    // 보는 탭을 api 로 돌리되 사용 시각은 오르지 않게 되돌린다 (보이는 것만으로 남는지 본다)
    ws().activateDoc(worktreeDiffDocId(API));
    const ledger = store.getState().repoSessions[folder] ?? {};
    store.setState({
      repoSessions: {
        ...store.getState().repoSessions,
        [folder]: {
          ...ledger,
          [API]: { ...(ledger[API] ?? { session: 0, held: true }), usedAt: 1 },
        },
      },
    });
    const auth = session(AUTH);
    await openDiff(DESIGN, 'README.md', 4_000);
    expect(release).toHaveBeenCalledWith(expect.any(Number), auth);
    expect(ws().sessionDocs.some((d) => d.id === worktreeDiffDocId(API))).toBe(true);
  });

  it('놓을 수 있는 세션이 없으면(보이는 탭 + 바쁜 둘) 열지 않고 알린다', async () => {
    const { store, ws, session, openDiff, release } = await setup();
    await openDiff(API, 'README.md', 1_000);
    await openDiff(AUTH, 'src/main/resources/config/rate-limit.yaml', 2_000);
    await openDiff(BILLING, 'README.md', 3_000);
    getSessionStore(session(API))?.setState({ busy: true });
    getSessionStore(session(AUTH))?.setState({ busy: true });
    // 보이는 탭은 billing 이다 (활성 저장소도 billing 이라 전환 잠금에 걸리지 않는다)
    expect(ws().activeDocId).toBe(worktreeDiffDocId(BILLING));
    expect(await openDiff(DESIGN, 'README.md', 4_000)).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(store.getState().toasts.at(-1)?.title).toBe(S.repoSession.limitBusy(3));
    expect(ws().sessionDocs).toHaveLength(3);
  });
});
