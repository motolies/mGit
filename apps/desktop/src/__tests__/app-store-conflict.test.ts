import { createMockClient, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import {
  clearSessionRegistry,
  getSessionStore,
  getWorkspaceStore,
} from '../store/session-registry';
import { conflictDocId, worktreeDiffDocId } from '../store/workspace-store';

// 목 폴더 장면: catalog-service 는 rebase 중 충돌 하나, 조절값 1 이면 billing-service 가 merge 중 충돌 둘
const FOLDER = '/mock/acme-platform';
const repo = (name: string) => `${FOLDER}/${name}`;
const API = repo('api-gateway');
const AUTH = repo('auth-service');
const BILLING = repo('billing-service');
const CATALOG = repo('catalog-service');
const WEB = repo('web-console');
const FACET = 'src/search/facets/FacetBuilder.kt';
const TOTALS = 'src/invoice/InvoiceTotals.kt';
const LIMITS = 'docs/billing-limits.md';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 앱 스토어로 폴더 탭을 연다 */
async function setup(folderOps = 0) {
  const client = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0, folderOps });
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
  const state = (path: string) => getSessionStore(session(path))?.getState();
  /** 충돌 파일을 연다 (Commit 도구 창·띠가 여는 길) */
  const openConflict = async (path: string, file: string) => {
    const ok = await store.getState().openRepoConflict(folder, path, file);
    await flush();
    return ok;
  };
  /** 열린 충돌에 초안을 만든다 (편집기가 알리는 것과 같은 열쇠) */
  const makeDraft = (path: string) => {
    const st = state(path);
    const open = st?.conflict;
    if (!st || !open) {
      throw new Error('열린 충돌 없음');
    }
    st.setConflictDraft(open.path, {
      text: 'mine',
      ranges: [],
      key: open.payload.file.stages.join(':'),
    });
  };
  return { client, store, folder, ws, session, state, openConflict, makeDraft };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  clearSessionRegistry();
});

describe('충돌 편집기 탭은 장부 세션의 충돌 슬롯에서 파생한다 (ED-06)', () => {
  it('열면 그 저장소 세션이 열리고 탭이 생겨 보인다. 저장소당 하나, 늘 고정, 저장하는 문서에는 없다', async () => {
    const { client, ws, state, openConflict } = await setup();
    const open = vi.spyOn(client, 'folderOpenRepoSession');
    expect(await openConflict(CATALOG, FACET)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(ws().sessionDocs.map((d) => [d.id, d.pinned, d.kind === 'conflict' && d.path])).toEqual([
      [conflictDocId(CATALOG), true, FACET],
    ]);
    expect(ws().activeDocId).toBe(conflictDocId(CATALOG));
    expect(ws().activeRepo).toBe(CATALOG);
    expect(ws().docs.map((d) => d.id)).toEqual(['overview']);
    // 가벼운 세션이 머지 도구 이름을 읽었다 (W15 의 STARTUP_LOADS)
    expect(state(CATALOG)?.profile).toBe('light');
    expect(state(CATALOG)?.mergeTool).toBe('meld');
    // 같은 파일을 다시 열어도 새로 읽지 않는다
    const read = vi.spyOn(client, 'conflictFile');
    await openConflict(CATALOG, FACET);
    expect(read).not.toHaveBeenCalled();
  });

  it('초안이 생기면 탭에 표시되고, 초안이 있는 탭을 닫으려 하면 확인을 먼저 받는다. 닫아도 초안은 남아 다시 열면 이어진다', async () => {
    const { store, ws, state, openConflict, makeDraft } = await setup();
    await openConflict(CATALOG, FACET);
    makeDraft(CATALOG);
    expect(ws().sessionDocs[0]).toMatchObject({ kind: 'conflict', draft: true });
    ws().closeDoc(conflictDocId(CATALOG));
    expect(store.getState().conflictLeave).toEqual({
      folder: store.getState().activeSessionId,
      repoPath: CATALOG,
      repoName: 'catalog-service',
      path: FACET,
      next: null,
    });
    // 아직 닫히지 않았다
    expect(state(CATALOG)?.conflict?.path).toBe(FACET);
    store.getState().cancelConflictLeave();
    expect(store.getState().conflictLeave).toBeNull();
    expect(ws().sessionDocs).toHaveLength(1);
    // 닫기 (초안 유지)
    ws().closeDoc(conflictDocId(CATALOG));
    store.getState().confirmConflictLeave(false);
    expect(ws().sessionDocs).toEqual([]);
    expect(Object.keys(state(CATALOG)?.conflictDrafts ?? {})).toEqual([FACET]);
    // 다시 열면 초안이 그대로다 (탭에 표시)
    await openConflict(CATALOG, FACET);
    expect(ws().sessionDocs[0]).toMatchObject({ draft: true });
    // 초안 버리고 닫기
    ws().closeDoc(conflictDocId(CATALOG));
    store.getState().confirmConflictLeave(true);
    expect(ws().sessionDocs).toEqual([]);
    expect(state(CATALOG)?.conflictDrafts).toEqual({});
  });

  it('초안이 없으면 확인 없이 닫는다', async () => {
    const { store, ws, openConflict } = await setup();
    await openConflict(CATALOG, FACET);
    ws().closeDoc(conflictDocId(CATALOG));
    expect(store.getState().conflictLeave).toBeNull();
    expect(ws().sessionDocs).toEqual([]);
  });

  it('같은 저장소의 다른 충돌 파일로 바꾸려 하면 초안이 있을 때 확인한다. 확인하면 그 파일로 바뀐다', async () => {
    const { store, ws, state, openConflict, makeDraft } = await setup(1);
    await openConflict(BILLING, TOTALS);
    makeDraft(BILLING);
    await openConflict(BILLING, LIMITS);
    expect(store.getState().conflictLeave).toMatchObject({ path: TOTALS, next: LIMITS });
    expect(state(BILLING)?.conflict?.path).toBe(TOTALS);
    store.getState().confirmConflictLeave(false);
    await flush();
    expect(state(BILLING)?.conflict?.path).toBe(LIMITS);
    // 탭은 하나 그대로 (저장소당 하나), 지금 파일에는 초안이 없다
    expect(ws().sessionDocs.map((d) => [d.id, d.kind === 'conflict' && d.draft])).toEqual([
      [conflictDocId(BILLING), false],
    ]);
    expect(Object.keys(state(BILLING)?.conflictDrafts ?? {})).toEqual([TOTALS]);
  });

  it('충돌 탭을 열면 같은 저장소의 작업 트리 diff 탭은 닫힌다 (세션 슬롯이 하나 — 저장소 탭의 규칙)', async () => {
    const { store, folder, ws, openConflict } = await setup();
    await store.getState().withRepoSession(folder, CATALOG, (st) => {
      void st.openFile('src/search/facets/FacetQuery.kt', true);
    });
    await flush();
    expect(ws().sessionDocs.map((d) => d.id)).toEqual([worktreeDiffDocId(CATALOG)]);
    await openConflict(CATALOG, FACET);
    expect(ws().sessionDocs.map((d) => d.id)).toEqual([conflictDocId(CATALOG)]);
  });
});

describe('초안과 세션 상한·활성 저장소 (W15)', () => {
  it('초안이 있는 세션은 상한에서 놓지 않는다 — 다른 셋이 모두 초안이면 네 번째를 열지 않고 알린다', async () => {
    const { client, store, folder, openConflict, makeDraft } = await setup(3);
    const release = vi.spyOn(client, 'folderReleaseRepoSession');
    await openConflict(CATALOG, FACET);
    makeDraft(CATALOG);
    await openConflict(BILLING, TOTALS);
    makeDraft(BILLING);
    await openConflict(API, 'src/routes/orders/handlers/create-order.ts');
    makeDraft(API);
    expect(
      await store.getState().withRepoSession(folder, AUTH, () => {
        throw new Error('열리면 안 된다');
      }),
    ).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(store.getState().toasts.at(-1)?.title).toBe(S.repoSession.limitBusy(3));
  });

  it('초안은 활성 저장소를 잠그지 않는다: 초안이 있어도 다른 저장소의 기능을 쓸 수 있고, 초안 세션은 남는다', async () => {
    const { store, folder, ws, session, openConflict, makeDraft } = await setup();
    await openConflict(CATALOG, FACET);
    makeDraft(CATALOG);
    const catalog = session(CATALOG);
    expect(
      await store.getState().withRepoSession(folder, WEB, (st) => {
        void st.openFile('apps/console/src/shared/api/orders.ts', false);
      }),
    ).toBe(true);
    expect(ws().activeRepo).toBe(WEB);
    expect(session(CATALOG)).toBe(catalog);
    expect(ws().sessionDocs.map((d) => d.id)).toContain(conflictDocId(CATALOG));
  });
});

describe('폴더 탭 닫기 확인 (WS-21)', () => {
  it('숨은 세션에 초안이 있으면 저장소 이름과 경로를 보이고 확인을 받는다. 취소하면 그대로, 확인하면 닫는다', async () => {
    const { client, store, folder, openConflict, makeDraft } = await setup();
    const closeFolder = vi.spyOn(client, 'closeFolder');
    await openConflict(CATALOG, FACET);
    makeDraft(CATALOG);
    await store.getState().requestCloseSession(folder);
    expect(store.getState().folderCloseConfirm).toEqual({
      id: folder,
      name: 'acme-platform',
      risks: [{ kind: 'draft', repoName: 'catalog-service', paths: [FACET] }],
    });
    expect(store.getState().closeConfirm).toBeNull();
    store.getState().cancelCloseSession();
    expect(store.getState().folderCloseConfirm).toBeNull();
    expect(store.getState().sessions[folder]).toBeDefined();
    await store.getState().requestCloseSession(folder);
    await store.getState().confirmCloseSession();
    expect(store.getState().sessions[folder]).toBeUndefined();
    expect(closeFolder).toHaveBeenCalledWith(folder);
  });

  it('숨은 세션에서 쓰기가 돌면 그것도 알린다', async () => {
    const { store, folder, session, openConflict } = await setup();
    await openConflict(CATALOG, FACET);
    getSessionStore(session(CATALOG))?.setState({ busy: true });
    await store.getState().requestCloseSession(folder);
    expect(store.getState().folderCloseConfirm?.risks).toEqual([
      { kind: 'running', repoName: 'catalog-service' },
    ]);
  });

  it('거기서 연 하위 저장소 탭이 있으면 초안이 없어도 확인한다 (탭 이름)', async () => {
    const { store, folder } = await setup();
    await store.getState().openRepositoryAt(WEB, folder);
    await flush();
    await store.getState().requestCloseSession(folder);
    expect(store.getState().folderCloseConfirm?.risks).toEqual([
      { kind: 'childTab', name: 'web-console', drafts: [] },
    ]);
  });

  it('잃는 것이 없으면 확인 없이 닫는다 (숨은 세션이 있어도 한가하면)', async () => {
    const { store, folder, openConflict } = await setup();
    await openConflict(CATALOG, FACET);
    await store.getState().requestCloseSession(folder);
    expect(store.getState().folderCloseConfirm).toBeNull();
    expect(store.getState().sessions[folder]).toBeUndefined();
  });

  it('저장소 탭의 닫기 확인은 그대로다 (초안 경로, 저장소 탭 문구의 상태)', async () => {
    const { store } = await setup();
    const id = await store.getState().openRepositoryAt(WEB);
    await flush();
    const tab = id === null ? undefined : getSessionStore(id);
    tab?.getState().setConflictDraft('x.ts', { text: 'x', ranges: [], key: 'k' });
    await store.getState().requestCloseSession(id ?? -1);
    expect(store.getState().closeConfirm).toEqual({ id, name: 'web-console', paths: ['x.ts'] });
    expect(store.getState().folderCloseConfirm).toBeNull();
  });
});
