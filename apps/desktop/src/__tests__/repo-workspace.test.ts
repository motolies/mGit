// W20·W21: 저장소 탭의 워크스페이스 상태. 저장소 탭 에디터 공간의 활성 문서(탭 자신의 세션 슬롯에서 파생한 세션 문서 +
// 파일 보기)가 "에디터에 무엇이 보이는가"를 정한다. 여기서 확인하는 것:
// - 수명: 저장소 탭을 열 때 만들고(새 세션·승격) 닫을 때 버린다 (폴더를 닫아 함께 닫힐 때도)
// - 파생: 슬롯 → 세션 문서 (작업 트리 diff, 커밋·범위 파일 diff, 충돌 + 초안 표시, 충돌을 읽는 중)
// - 문서 전이표: 전이마다 에디터의 활성 세션 문서(`shownSlot`: diff·conflict·null = 세션 문서가 안 보임). W20 의
//   "탭 막대가 없는 동안의 규칙(사라지면 늘 그래프)"은 W21 에서 폴더 탭과 같은 "직전 문서로"가 됐다. 커밋으로 가기는 에디터를
//   그대로 두고 Git 도구 창의 로그 탭을 연다
// - 같은 세션을 저장소 탭과 폴더 탭이 함께 볼 때

import { createMockClient, type SessionId, type StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docDetail, docTitle, docTooltip } from '../features/workspace/doc-labels';
import { createAppStore } from '../store/app-store';
import {
  clearSessionRegistry,
  getSessionStore,
  getWorkspaceStore,
} from '../store/session-registry';
import type { SessionDocSlot, SessionState } from '../store/session-store';
import {
  allDocs,
  conflictDocId,
  docClosed,
  docRepoPath,
  type EditorTabs,
  historyDiffDocId,
  isSessionDoc,
  OVERVIEW_DOC,
  type RepoDocSlot,
  repoSessionDocs,
  sessionDocSlot,
  sessionDocsReplaced,
  worktreeDiffDocId,
} from '../store/workspace-store';

const flush = () => new Promise((r) => setTimeout(r, 0));

// 목 충돌 장면: 저장소 하나, 충돌 둘(텍스트 PaymentStep, 삭제 CardForm), staged 셋
const CONFLICT_REPO = '/mock/checkout-service';
const PAY = 'src/features/checkout/steps/PaymentStep.tsx';
const STAGED = 'src/features/checkout/CheckoutPage.tsx';

// 목 폴더 장면
const FOLDER = '/mock/acme-platform';
const AUTH = `${FOLDER}/auth-service`;
const CATALOG = `${FOLDER}/catalog-service`;
const LOGIN = 'src/main/java/com/acme/auth/login/LoginController.java';
const FACET = 'src/search/facets/FacetBuilder.kt';

/** 값이 있다고 확인하고 돌려준다 */
function present<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${what} 없음`);
  }
  return value;
}

/** 테스트가 만든 앱 스토어 (끝나면 탭을 모두 닫는다 — 워크스페이스 등록부는 테스트 사이에 남기 때문) */
let apps: ReturnType<typeof createAppStore>[] = [];

/** 목 클라이언트로 앱 스토어를 만든다. 세션 id 가 목마다 1부터라 한 테스트에 하나만 만든다 */
function app(scene: 'conflict' | 'folder') {
  const client = createMockClient({ rows: 60, scene, progressIntervalMs: 0 });
  const store = createAppStore({ client, pickDirectory: async () => null });
  apps.push(store);
  return { client, store };
}

/** 그 탭의 세션 상태 */
const sessionOf = (id: SessionId) => present(getSessionStore(id), '세션 스토어').getState();
/** 그 탭의 워크스페이스 상태 */
const workspaceOf = (id: SessionId) => present(getWorkspaceStore(id), '워크스페이스').getState();
/**
 * 활성 문서가 세션 문서면 그 슬롯, 아니면(저장한 문서·활성 문서 없음) null. 앱은 쓰지 않고 이 테스트의 관찰에만 쓰여
 * W28 에서 워크스페이스 스토어에서 여기로 옮겼다
 */
function shownSlot(
  tabs: Pick<EditorTabs, 'docs' | 'sessionDocs' | 'activeDocId'>,
): SessionDocSlot | null {
  const doc = allDocs(tabs).find((d) => d.id === tabs.activeDocId);
  return doc && isSessionDoc(doc) ? sessionDocSlot(doc) : null;
}
/** 저장소 탭 에디터 공간에 보이는 세션 문서: 'diff'·'conflict'·null(세션 문서가 활성이 아님 — 빈 에디터나 파일 보기) */
const shownIn = (id: SessionId) => shownSlot(workspaceOf(id));

/** 충돌 장면의 저장소를 저장소 탭으로 연다 */
async function openConflictRepo() {
  const { client, store } = app('conflict');
  const id = present(await store.getState().openRepositoryAt(CONFLICT_REPO), '탭 id');
  await flush();
  return { client, store, id, st: () => sessionOf(id), ws: () => workspaceOf(id) };
}

/** 그 경로를 뺀 상태 이벤트 (밖에서 해결·stage 되어 상태에서 사라졌다) */
function statusWithout(st: SessionState, id: SessionId, path: string) {
  return {
    type: 'statusChanged' as const,
    session: id,
    status: {
      ...st.status,
      entries: st.status.entries.filter((e: StatusEntry) => e.path !== path),
    },
    op: st.op,
  };
}

/** 슬롯 기본값 (빈 세션) */
const EMPTY_SLOT: RepoDocSlot = {
  selectedFile: null,
  conflict: null,
  conflictDrafts: {},
  conflictLoading: false,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  for (const store of apps) {
    for (const id of [...store.getState().sessionOrder].reverse()) {
      await store.getState().closeSession(id);
    }
  }
  apps = [];
  clearSessionRegistry();
});

describe('저장소 탭의 세션 문서는 탭 자신의 세션 슬롯에서 파생한다 (계획 5.2, W20)', () => {
  it('작업 트리 파일 → 작업 트리 diff 문서, 커밋·범위 파일 → 커밋·범위 파일 diff 문서 (diff 슬롯 하나라 늘 하나)', () => {
    const worktree = repoSessionDocs('/r', 'r', {
      ...EMPTY_SLOT,
      selectedFile: { path: 'a.ts', staged: true, commit: null },
    });
    expect(worktree).toEqual([
      {
        id: worktreeDiffDocId('/r'),
        kind: 'worktreeDiff',
        repoPath: '/r',
        repoName: 'r',
        path: 'a.ts',
        staged: true,
      },
    ]);
    const commit = repoSessionDocs('/r', 'r', {
      ...EMPTY_SLOT,
      selectedFile: { path: 'a.ts', staged: false, commit: 'c'.repeat(40), oldPath: null },
    });
    expect(commit).toEqual([
      {
        id: historyDiffDocId('/r'),
        kind: 'historyDiff',
        repoPath: '/r',
        repoName: 'r',
        path: 'a.ts',
        rev: { kind: 'commit', oid: 'c'.repeat(40) },
      },
    ]);
    const range = repoSessionDocs('/r', 'r', {
      ...EMPTY_SLOT,
      selectedFile: {
        path: 'a.ts',
        staged: false,
        commit: null,
        range: { base: 'b', newer: 'n', label: 'o..n' },
      },
    });
    expect(range.map((d) => [d.id, d.kind === 'historyDiff' && d.rev])).toEqual([
      [historyDiffDocId('/r'), { kind: 'range', label: 'o..n' }],
    ]);
    expect(repoSessionDocs('/r', 'r', EMPTY_SLOT)).toEqual([]);
  });

  it('충돌 → 충돌 문서(초안이면 표시), 읽는 중이고 아직 충돌이 없으면 경로가 빈 충돌 문서. diff 뒤에 충돌', () => {
    const file = { stages: ['a', 'b', 'c'] };
    const conflict = { path: 'x.ts', payload: { file } as never };
    const draft = { text: 't', ranges: [], key: 'a:b:c' };
    const docs = repoSessionDocs('/r', 'r', {
      selectedFile: { path: 'a.ts', staged: false, commit: null },
      conflict,
      conflictDrafts: { 'x.ts': draft },
      conflictLoading: false,
    });
    expect(docs.map((d) => [d.id, d.kind === 'conflict' && [d.path, d.draft]])).toEqual([
      [worktreeDiffDocId('/r'), false],
      [conflictDocId('/r'), ['x.ts', true]],
    ]);
    // 다른 충돌(블롭 조합이 다름)의 초안은 표시하지 않는다
    const other = repoSessionDocs('/r', 'r', {
      ...EMPTY_SLOT,
      conflict,
      conflictDrafts: { 'x.ts': { ...draft, key: 'z' } },
    });
    expect(other.map((d) => d.kind === 'conflict' && d.draft)).toEqual([false]);
    // 읽는 중: 아직 충돌이 없으면 빈 경로의 충돌 문서 하나, 앞 충돌이 남아 있으면 그 문서 하나 (같은 id)
    const loading = repoSessionDocs('/r', 'r', { ...EMPTY_SLOT, conflictLoading: true });
    expect(loading.map((d) => [d.id, d.kind === 'conflict' && d.path])).toEqual([
      [conflictDocId('/r'), ''],
    ]);
    const reloading = repoSessionDocs('/r', 'r', {
      ...EMPTY_SLOT,
      conflict,
      conflictLoading: true,
    });
    expect(reloading.map((d) => [d.id, d.kind === 'conflict' && d.path])).toEqual([
      [conflictDocId('/r'), 'x.ts'],
    ]);
  });
});

describe('커밋·범위 파일 diff 문서와 활성 문서 규칙 (순수 함수, W20)', () => {
  const commitDoc = repoSessionDocs('/w/api', 'api', {
    ...EMPTY_SLOT,
    selectedFile: { path: 'src/a.ts', staged: false, commit: 'a1b2c3d4e5'.padEnd(40, '0') },
  })[0];
  const rangeDoc = repoSessionDocs('/w/api', 'api', {
    ...EMPTY_SLOT,
    selectedFile: {
      path: 'src/a.ts',
      staged: false,
      commit: null,
      range: { base: 'b', newer: 'n', label: 'c0ffee12..a1b2c3d4' },
    },
  })[0];

  it('세션 문서이고(diff 슬롯) 저장소가 있으며, 제목·툴팁은 커밋·범위를 밝힌다', () => {
    const commit = present(commitDoc, '커밋 문서');
    const range = present(rangeDoc, '범위 문서');
    expect(isSessionDoc(commit)).toBe(true);
    expect(isSessionDoc(commit) && sessionDocSlot(commit)).toBe('diff');
    expect(docRepoPath(commit)).toBe('/w/api');
    expect(docTitle(commit)).toBe('a.ts @a1b2c3d4');
    expect(docDetail(commit)).toBe('api');
    expect(docTooltip(commit)).toBe('api: src/a.ts @a1b2c3d4');
    expect(docTitle(range)).toBe('a.ts');
    expect(docTooltip(range)).toBe(
      S.workspace.worktreeDiffTip('api', 'src/a.ts', 'c0ffee12..a1b2c3d4'),
    );
  });

  it('활성 문서가 사라지면(닫힘·슬롯이 빔) 직전 문서로 돌아간다 — 저장소 탭도 폴더 탭과 같다 (W21: W20 의 `none` 을 걷었다)', () => {
    const a = { ...OVERVIEW_DOC, pinned: true };
    const b = { ...present(commitDoc, '커밋 문서'), pinned: true };
    const tabs = { docs: [a], sessionDocs: [b], activeDocId: b.id, recentDocIds: [a.id, b.id] };
    expect(sessionDocsReplaced(tabs, []).activeDocId).toBe(a.id);
    const onA = { ...tabs, activeDocId: a.id, recentDocIds: [b.id, a.id] };
    expect(docClosed(onA, a.id).activeDocId).toBe(b.id);
    // 남은 문서가 없으면 아무것도 보이지 않는다
    expect(
      sessionDocsReplaced({ ...tabs, docs: [], recentDocIds: [b.id] }, []).activeDocId,
    ).toBeNull();
    expect(shownSlot(tabs)).toBe('diff');
    expect(shownSlot(onA)).toBeNull();
    expect(shownSlot({ ...tabs, activeDocId: null })).toBeNull();
  });
});

describe('저장소 탭 Project 도구 창의 파일 트리 (W21)', () => {
  it('세션 스토어가 그 세션의 파일 API 로 만든 트리를 갖는다. 연 적이 없으면 ref 변경·새로고침에 읽지 않고, 열었으면 펼친 디렉터리를 다시 읽는다', async () => {
    const { client, store, st, id } = await openConflictRepo();
    const list = vi.spyOn(client, 'fsListDir');
    /** 이 세션으로 루트를 읽었는지 */
    const listedRoot = () => list.mock.calls.some(([session, dir]) => session === id && dir === '');
    const refs = { type: 'refsChanged' as const, session: id, refs: st().refs };
    st().applyEvent(refs);
    await store.getState().refreshActive();
    await flush();
    expect(list).not.toHaveBeenCalled();

    st().fileTree.getState().open();
    await flush();
    expect(listedRoot()).toBe(true);
    expect(st().fileTree.getState().dirs['']?.load.state).toBe('listed');
    list.mockClear();
    // 자체 작업 뒤(ref 가 옮겨졌다)·새로고침(⌘R) 때 다시 읽는다
    st().applyEvent(refs);
    await flush();
    expect(listedRoot()).toBe(true);
    list.mockClear();
    await store.getState().refreshActive();
    expect(listedRoot()).toBe(true);
  });
});

describe('저장소 탭 워크스페이스의 수명 (W20)', () => {
  it('저장소 탭을 열면 저장소 워크스페이스가 생기고(문서 없음 = 그래프), 닫으면 버린다. 두 번 닫아도 안전하고 다시 열면 새것이다', async () => {
    const { store } = app('conflict');
    const id = present(await store.getState().openRepositoryAt(CONFLICT_REPO), '탭 id');
    const first = present(getWorkspaceStore(id), '워크스페이스');
    expect(first.getState().rootKind).toBe('repo');
    expect(first.getState().docs).toEqual([]);
    expect(first.getState().sessionDocs).toEqual([]);
    expect(shownIn(id)).toBeNull();
    // 이미 열린 저장소를 다시 열면 같은 탭·같은 워크스페이스
    expect(await store.getState().openRepositoryAt(CONFLICT_REPO)).toBe(id);
    expect(getWorkspaceStore(id)).toBe(first);

    await store.getState().closeSession(id);
    expect(getWorkspaceStore(id)).toBeUndefined();
    expect(getSessionStore(id)).toBeUndefined();
    await store.getState().closeSession(id);
    expect(getWorkspaceStore(id)).toBeUndefined();

    const again = present(await store.getState().openRepositoryAt(CONFLICT_REPO), '탭 id');
    expect(getWorkspaceStore(again)).toBeDefined();
    expect(getWorkspaceStore(again)).not.toBe(first);
  });

  it('폴더가 연 숨은 세션이 탭으로 승격되면 같은 세션의 워크스페이스가 생기고, 폴더에서 연 diff 를 그대로 보인다 (옛 화면도 diff)', async () => {
    const { store } = app('folder');
    await store.getState().openFolderAt(FOLDER);
    const folder = present(store.getState().activeSessionId, '폴더 id');
    await flush();
    // 폴더 Commit 도구 창에서 파일을 연 것과 같은 길 (`useRepoSessionActions().openDiff`)
    await store.getState().withRepoSession(folder, AUTH, (st) => {
      void st.openFile(LOGIN, false);
      workspaceOf(folder).revealDoc(worktreeDiffDocId(AUTH));
    });
    const hidden = present(store.getState().repoSessions[folder]?.[AUTH], '장부 항목').session;
    expect(getWorkspaceStore(hidden)).toBeUndefined();

    const id = present(await store.getState().openRepositoryAt(AUTH, folder), '탭 id');
    expect(id).toBe(hidden);
    expect(workspaceOf(id).rootKind).toBe('repo');
    expect(workspaceOf(id).activeDocId).toBe(worktreeDiffDocId(AUTH));
    expect(shownIn(id)).toBe('diff');
    // 빌림이 된 장부 항목은 남고 폴더 탭의 diff 탭도 남는다
    expect(store.getState().repoSessions[folder]?.[AUTH]).toMatchObject({
      session: id,
      held: false,
    });
    expect(workspaceOf(folder).sessionDocs.map((d) => d.id)).toEqual([worktreeDiffDocId(AUTH)]);

    // 탭을 닫으면 세션이 닫힌다: 워크스페이스·세션 스토어를 버리고, 폴더 장부 항목과 폴더의 diff 탭도 사라진다
    // (가벼운 세션으로 남는 길은 없다 — 다음에 필요하면 폴더가 새로 연다)
    await store.getState().closeSession(id);
    expect(getWorkspaceStore(id)).toBeUndefined();
    expect(getSessionStore(id)).toBeUndefined();
    expect(store.getState().repoSessions[folder]?.[AUTH]).toBeUndefined();
    expect(workspaceOf(folder).sessionDocs).toEqual([]);
    expect(workspaceOf(folder).activeDocId).toBe('overview');
    expect(getWorkspaceStore(folder)).toBeDefined();
  });

  it('충돌을 연 숨은 세션이 승격되면 충돌을 보인다. 폴더 탭을 닫으면 함께 닫히는 저장소 탭의 워크스페이스도 버린다', async () => {
    const { store } = app('folder');
    await store.getState().openFolderAt(FOLDER);
    const folder = present(store.getState().activeSessionId, '폴더 id');
    await flush();
    expect(await store.getState().openRepoConflict(folder, CATALOG, FACET)).toBe(true);
    await flush();
    const id = present(await store.getState().openRepositoryAt(CATALOG, folder), '탭 id');
    expect(workspaceOf(id).activeDocId).toBe(conflictDocId(CATALOG));
    expect(shownIn(id)).toBe('conflict');
    const other = present(await store.getState().openRepositoryAt(AUTH, folder), '탭 id');
    expect(getWorkspaceStore(other)).toBeDefined();

    await store.getState().closeSession(folder);
    expect(getWorkspaceStore(folder)).toBeUndefined();
    expect(getWorkspaceStore(id)).toBeUndefined();
    expect(getWorkspaceStore(other)).toBeUndefined();
    expect(store.getState().sessions).toEqual({});
  });
});

describe('세션 슬롯 전이 → 저장소 탭 에디터의 활성 문서 (ED-10 W20 → W21)', () => {
  it('파일 열기 → diff, 뒤로(닫기) → 그래프. 다른 파일을 열면 diff 그대로 내용만 바뀐다', async () => {
    const { st, ws, id } = await openConflictRepo();
    expect(shownIn(id)).toBeNull();
    await st().openFile(STAGED, true);
    expect(shownIn(id)).toBe('diff');
    expect(ws().activeDocId).toBe(worktreeDiffDocId(CONFLICT_REPO));
    await st().openFile('src/features/checkout/api/createOrder.ts', true);
    expect(shownIn(id)).toBe('diff');
    expect(ws().sessionDocs.map((d) => d.kind === 'worktreeDiff' && d.path)).toEqual([
      'src/features/checkout/api/createOrder.ts',
    ]);
    // "← 그래프로"(DiffPane 의 closeFile)
    st().closeFile();
    expect(shownIn(id)).toBeNull();
    expect(ws().sessionDocs).toEqual([]);
  });

  it('커밋 파일·범위 파일 열기 → diff (커밋·범위 파일 diff 문서), 범위가 지워지면 → 그래프', async () => {
    const { st, ws, id } = await openConflictRepo();
    await st().openCommitFile('c'.repeat(40), 'a.ts');
    expect(shownIn(id)).toBe('diff');
    expect(ws().activeDocId).toBe(historyDiffDocId(CONFLICT_REPO));
    // 작업 트리 파일로 바꾸면 그 문서가 보인다
    await st().openFile(STAGED, true);
    expect(ws().activeDocId).toBe(worktreeDiffDocId(CONFLICT_REPO));
    st().closeFile();
    expect(shownIn(id)).toBeNull();
    const range = {
      from: 0,
      to: 1,
      newer: 'b'.repeat(40),
      older: 'c'.repeat(40),
      base: 'd'.repeat(40),
      files: [],
      loading: false,
    };
    present(getSessionStore(id), '세션').setState({ range });
    await st().openRangeFile('r.ts');
    expect(shownIn(id)).toBe('diff');
    expect(ws().activeDocId).toBe(historyDiffDocId(CONFLICT_REPO));
    // 옛 rangeCleared: 범위 diff 가 보이던 중이면 그래프로
    st().selectWip();
    expect(st().selectedFile).toBeNull();
    expect(shownIn(id)).toBeNull();
  });

  it('충돌 열기 → 읽는 동안에도 충돌 화면(불러오는 중), 다 읽으면 그 충돌. 목록으로(닫기) → 그래프', async () => {
    const { st, ws, id } = await openConflictRepo();
    const opening = st().openConflict(PAY);
    // 옛: 시작하자마자 'conflict' + conflict=null → "불러오는 중" 칸
    expect(st().conflict).toBeNull();
    expect(st().conflictLoading).toBe(true);
    expect(shownIn(id)).toBe('conflict');
    expect(ws().sessionDocs.map((d) => d.kind === 'conflict' && d.path)).toEqual(['']);
    await opening;
    expect(shownIn(id)).toBe('conflict');
    expect(ws().sessionDocs.map((d) => d.kind === 'conflict' && d.path)).toEqual([PAY]);
    // "← 목록으로"(ConflictPane 의 closeConflict)
    st().closeConflict();
    expect(shownIn(id)).toBeNull();
  });

  it('충돌을 못 읽으면 → 그래프 (오류는 세션 오류 줄)', async () => {
    const { st, id } = await openConflictRepo();
    await st().openFile(STAGED, true);
    await st().openConflict('missing.ts');
    expect(st().conflict).toBeNull();
    expect(st().actionError).toBeTruthy();
    expect(shownIn(id)).toBeNull();
  });

  it('diff 를 보다 충돌을 열면 diff 슬롯이 비고 충돌, 그 충돌을 닫으면 → 그래프 (돌아갈 diff 가 없다)', async () => {
    const { st, ws, id } = await openConflictRepo();
    await st().openFile(STAGED, true);
    await st().openConflict(PAY);
    expect(st().selectedFile).toBeNull();
    expect(shownIn(id)).toBe('conflict');
    expect(ws().sessionDocs.map((d) => d.kind)).toEqual(['conflict']);
    st().closeConflict();
    expect(shownIn(id)).toBeNull();
  });

  it('충돌을 보다 파일을 열면 diff(충돌 슬롯은 남는다), 그 diff 를 닫으면 → 직전 문서(충돌 탭) (W21: 탭 막대에 보이는 충돌 탭으로 돌아간다)', async () => {
    const { st, ws, id } = await openConflictRepo();
    await st().openConflict(PAY);
    await st().openFile(STAGED, true);
    expect(st().conflict?.path).toBe(PAY);
    expect(shownIn(id)).toBe('diff');
    expect(ws().sessionDocs.map((d) => d.kind)).toEqual(['worktreeDiff', 'conflict']);
    st().closeFile();
    expect(shownIn(id)).toBe('conflict');
    expect(ws().sessionDocs.map((d) => d.kind)).toEqual(['conflict']);
    // 충돌도 닫으면 남은 문서가 없다
    st().closeConflict();
    expect(shownIn(id)).toBeNull();
  });

  it('밖에서 보이던 충돌이 해결되면 → 그래프', async () => {
    const { st, id } = await openConflictRepo();
    await st().openConflict(PAY);
    st().applyEvent(statusWithout(st(), id, PAY));
    expect(st().conflict).toBeNull();
    expect(shownIn(id)).toBeNull();
  });

  it('보이던 작업 트리 diff 의 파일이 상태에서 사라지면(stage·되돌리기) → 그래프', async () => {
    const { st, id } = await openConflictRepo();
    await st().openFile(STAGED, true);
    st().applyEvent(statusWithout(st(), id, STAGED));
    expect(st().selectedFile).toBeNull();
    expect(shownIn(id)).toBeNull();
  });

  it('충돌을 열어 둔 채 diff 를 보던 중 숨은 충돌이 해결되면 → diff 그대로', async () => {
    const { st, id } = await openConflictRepo();
    await st().openConflict(PAY);
    await st().openFile(STAGED, true);
    st().applyEvent(statusWithout(st(), id, PAY));
    expect(st().conflict).toBeNull();
    expect(st().selectedFile?.path).toBe(STAGED);
    expect(shownIn(id)).toBe('diff');
  });

  it('커밋으로 가기(jumpToCommit) → 로그 보이기 훅: Git 도구 창의 로그 탭을 열고 에디터의 문서는 그대로 둔다 (W21)', async () => {
    const { client, store, st, ws, id } = await openConflictRepo();
    vi.spyOn(client, 'findRow').mockResolvedValue(3);
    await st().openFile(STAGED, true);
    // 콘솔 탭을 보는 중이었다
    store.getState().setGitDockTab('console');
    await st().jumpToCommit('e'.repeat(40));
    expect(st().scrollToRow).toBe(3);
    expect(st().selectedCommit).toBe('e'.repeat(40));
    expect(store.getState().dock).toMatchObject({ tool: 'git', gitTab: 'log' });
    // 에디터는 그대로 diff 다 (W20 은 그래프를 보이려고 문서를 내렸다)
    expect(shownIn(id)).toBe('diff');
    expect(st().selectedFile?.path).toBe(STAGED);
    expect(ws().sessionDocs.map((d) => d.id)).toEqual([worktreeDiffDocId(CONFLICT_REPO)]);

    // 숨긴 도구 창도 연다. 최대화는 건드리지 않는다
    store.getState().hideDock();
    await st().jumpToCommit('e'.repeat(40));
    expect(store.getState().dock).toMatchObject({ tool: 'git', gitTab: 'log', maximized: false });
    store.getState().toggleDockMaximized();
    await st().jumpToCommit('e'.repeat(40));
    expect(store.getState().dock).toMatchObject({ tool: 'git', gitTab: 'log', maximized: true });

    // 충돌 화면에서 커밋으로 가도 같다 (출처 커밋): 충돌 탭은 그대로
    await st().openConflict(PAY);
    await st().jumpToCommit('f'.repeat(40));
    expect(shownIn(id)).toBe('conflict');
    // 행을 못 찾으면 도구 창을 건드리지 않는다
    store.getState().setGitDockTab('console');
    vi.spyOn(client, 'findRow').mockResolvedValue(null);
    await st().jumpToCommit('0'.repeat(40));
    expect(store.getState().dock.gitTab).toBe('console');
    expect(shownIn(id)).toBe('conflict');
  });

  it('충돌을 읽는 동안 파일을 열면 그쪽이 보이고(충돌 탭은 생긴다), 커밋으로 가도 읽기가 끝난 충돌 탭이 그대로 보인다 (W21)', async () => {
    const { client, st, ws, id } = await openConflictRepo();
    const opening = st().openConflict(PAY);
    void st().openFile(STAGED, true);
    await opening;
    expect(st().conflict?.path).toBe(PAY);
    expect(shownIn(id)).toBe('diff');
    expect(ws().sessionDocs.map((d) => d.kind)).toEqual(['worktreeDiff', 'conflict']);

    vi.spyOn(client, 'findRow').mockResolvedValue(1);
    st().closeFile();
    st().closeConflict();
    const again = st().openConflict(PAY);
    await st().jumpToCommit('e'.repeat(40));
    await again;
    expect(st().conflict?.path).toBe(PAY);
    expect(shownIn(id)).toBe('conflict');
  });

  it('Esc·탭 닫기(워크스페이스의 닫기)는 슬롯을 비운다: diff 는 바로, 충돌은 초안이 있으면 확인을 먼저 받는다 (W21 — 폴더 탭과 같다)', async () => {
    const { store, st, ws, id } = await openConflictRepo();
    await st().openFile(STAGED, true);
    ws().closeDoc(present(ws().activeDocId, '활성 문서'));
    expect(st().selectedFile).toBeNull();
    expect(shownIn(id)).toBeNull();

    await st().openConflict(PAY);
    const open = present(st().conflict, '열린 충돌');
    const draft = { text: 'mine', ranges: [], key: open.payload.file.stages.join(':') };
    st().setConflictDraft(PAY, draft);
    expect(ws().sessionDocs.map((d) => d.kind === 'conflict' && d.draft)).toEqual([true]);
    ws().closeDoc(conflictDocId(CONFLICT_REPO));
    // 확인을 받는 동안 닫지 않는다. 확인창의 저장소 이름은 탭 이름이다
    expect(store.getState().conflictLeave).toEqual({
      folder: id,
      repoPath: CONFLICT_REPO,
      repoName: 'checkout-service',
      path: PAY,
      next: null,
    });
    expect(shownIn(id)).toBe('conflict');
    store.getState().cancelConflictLeave();
    expect(st().conflict?.path).toBe(PAY);
    // 닫기: 초안은 남는다
    ws().closeDoc(conflictDocId(CONFLICT_REPO));
    store.getState().confirmConflictLeave(false);
    expect(st().conflict).toBeNull();
    expect(shownIn(id)).toBeNull();
    expect(st().conflictDrafts[PAY]).toEqual(draft);
    // 다시 열면 이어지고, 초안 버리고 닫기는 초안도 지운다
    await st().openConflict(PAY);
    expect(ws().sessionDocs.map((d) => d.kind === 'conflict' && d.draft)).toEqual([true]);
    ws().closeDoc(conflictDocId(CONFLICT_REPO));
    store.getState().confirmConflictLeave(true);
    expect(st().conflict).toBeNull();
    expect(st().conflictDrafts[PAY]).toBeUndefined();
    // 초안이 없으면 확인 없이 닫는다
    await st().openConflict(PAY);
    ws().closeDoc(conflictDocId(CONFLICT_REPO));
    expect(store.getState().conflictLeave).toBeNull();
    expect(st().conflict).toBeNull();
  });

  it('일괄 닫기는 충돌 확인을 기다리고 취소하면 다음 문서를 보존한다', async () => {
    const { store, st, ws } = await openConflictRepo();
    await st().openConflict(PAY);
    await st().openFile(STAGED, true);
    const open = present(st().conflict, '열린 충돌');
    st().setConflictDraft(PAY, {
      text: 'mine',
      ranges: [],
      key: open.payload.file.stages.join(':'),
    });
    const ids = [conflictDocId(CONFLICT_REPO), worktreeDiffDocId(CONFLICT_REPO)];
    const closing = ws().closeDocs(ids);
    expect(store.getState().conflictLeave?.path).toBe(PAY);
    expect(st().selectedFile?.path).toBe(STAGED);
    store.getState().cancelConflictLeave();
    expect(await closing).toBe(false);
    expect(ws().sessionDocs).toHaveLength(2);

    const retry = ws().closeDocs(ids);
    store.getState().confirmConflictLeave(false);
    expect(await retry).toBe(true);
    expect(ws().sessionDocs).toHaveLength(0);
    expect(st().conflictDrafts[PAY]?.text).toBe('mine');
  });

  it('diff를 먼저 닫아 파생 문서 목록이 갱신되어도 뒤의 충돌 탭까지 닫는다', async () => {
    const { store, st, ws } = await openConflictRepo();
    await st().openConflict(PAY);
    await st().openFile(STAGED, true);
    const open = present(st().conflict, '열린 충돌');
    st().setConflictDraft(PAY, {
      text: 'mine',
      ranges: [],
      key: open.payload.file.stages.join(':'),
    });
    const closing = ws().closeDocs([
      worktreeDiffDocId(CONFLICT_REPO),
      conflictDocId(CONFLICT_REPO),
    ]);
    await flush();
    expect(st().selectedFile).toBeNull();
    expect(store.getState().conflictLeave?.path).toBe(PAY);
    store.getState().confirmConflictLeave(true);
    expect(await closing).toBe(true);
    expect(ws().sessionDocs).toHaveLength(0);
    expect(st().conflictDrafts[PAY]).toBeUndefined();
  });

  it('문서가 열리면 아래 도구 창의 최대화를 푼다 (W21 — 폴더 탭의 `onDocOpened` 와 같은 규칙, WS-03)', async () => {
    const { store, st, ws, id } = await openConflictRepo();
    store.getState().toggleDockMaximized();
    expect(store.getState().dock.maximized).toBe(true);
    await st().openFile(STAGED, true);
    expect(shownIn(id)).toBe('diff');
    expect(store.getState().dock.maximized).toBe(false);
    // 파일 보기 문서도 같다
    store.getState().toggleDockMaximized();
    ws().openDoc(
      {
        id: 'file:README.md',
        kind: 'file',
        path: 'README.md',
        name: 'README.md',
        repoPath: CONFLICT_REPO,
        repoName: 'checkout-service',
      },
      'preview',
    );
    expect(store.getState().dock.maximized).toBe(false);
  });

  it('로그 보이기 훅은 그 저장소 탭이 활성 탭일 때만 도구 창을 바꾼다 (다른 탭을 보는 중이면 그대로)', async () => {
    const { client, store, st, id } = await openConflictRepo();
    vi.spyOn(client, 'findRow').mockResolvedValue(2);
    store.getState().setGitDockTab('console');
    store.setState({ activeSessionId: null });
    await st().jumpToCommit('e'.repeat(40));
    expect(st().scrollToRow).toBe(2);
    expect(store.getState().dock.gitTab).toBe('console');
    store.setState({ activeSessionId: id });
  });
});

describe('같은 세션을 저장소 탭과 폴더 탭이 함께 볼 때 (W14·W15 가 받아들인 동작, W20)', () => {
  /** 폴더를 열고 그 저장소를 저장소 탭으로 연 뒤, 폴더도 그 세션을 빌린다 */
  async function shared(repoPath = AUTH) {
    const { client, store } = app('folder');
    await store.getState().openFolderAt(FOLDER);
    const folder = present(store.getState().activeSessionId, '폴더 id');
    await flush();
    const id = present(await store.getState().openRepositoryAt(repoPath, folder), '탭 id');
    await flush();
    await store.getState().withRepoSession(folder, repoPath, () => {});
    expect(store.getState().repoSessions[folder]?.[repoPath]).toMatchObject({
      session: id,
      held: false,
    });
    return { client, store, folder, id, st: () => sessionOf(id) };
  }

  it('한쪽에서 연 diff 가 양쪽에 문서로 생긴다 — 저장소 탭은 보이고 폴더 탭은 활성 탭이 그대로다. 폴더에서 닫으면 양쪽이 직전 화면으로', async () => {
    const { folder, id, st } = await shared();
    await st().openFile(LOGIN, false);
    expect(shownIn(id)).toBe('diff');
    expect(workspaceOf(folder).sessionDocs.map((d) => d.id)).toEqual([worktreeDiffDocId(AUTH)]);
    expect(workspaceOf(folder).activeDocId).toBe('overview');

    // 폴더에서 그 탭을 보고(여는 쪽의 revealDoc) 닫는다
    workspaceOf(folder).revealDoc(worktreeDiffDocId(AUTH));
    workspaceOf(folder).closeDoc(worktreeDiffDocId(AUTH));
    expect(st().selectedFile).toBeNull();
    expect(workspaceOf(folder).sessionDocs).toEqual([]);
    // 폴더 탭은 직전 문서(개요), 저장소 탭은 남은 문서가 없어 빈 에디터 (둘 다 "직전 문서로" 규칙, W21)
    expect(workspaceOf(folder).activeDocId).toBe('overview');
    expect(shownIn(id)).toBeNull();
    expect(workspaceOf(id).activeDocId).toBeNull();
  });

  it('폴더에서 연 diff 도 저장소 탭에 보인다(옛 화면이 세션의 가운데 화면 값을 함께 쓴 것과 같다). 저장소 탭에서 닫으면 폴더 탭도 그 탭이 닫혀 직전 문서로', async () => {
    const { store, folder, id, st } = await shared();
    // 폴더 Commit 도구 창의 diff 열기
    await store.getState().withRepoSession(folder, AUTH, (s) => {
      void s.openFile(LOGIN, false);
      workspaceOf(folder).revealDoc(worktreeDiffDocId(AUTH));
    });
    expect(workspaceOf(folder).activeDocId).toBe(worktreeDiffDocId(AUTH));
    expect(shownIn(id)).toBe('diff');
    // 저장소 탭의 Esc·뒤로
    workspaceOf(id).closeDoc(worktreeDiffDocId(AUTH));
    expect(st().selectedFile).toBeNull();
    expect(shownIn(id)).toBeNull();
    expect(workspaceOf(folder).sessionDocs).toEqual([]);
    expect(workspaceOf(folder).activeDocId).toBe('overview');
  });

  it('폴더에서 연 충돌도 저장소 탭에 보인다. 저장소 탭에서 닫으면(확인 없음) 폴더 탭의 충돌 탭도 닫혀 직전 문서로', async () => {
    const { store, folder, id, st } = await shared(CATALOG);
    expect(await store.getState().openRepoConflict(folder, CATALOG, FACET)).toBe(true);
    await flush();
    expect(workspaceOf(folder).activeDocId).toBe(conflictDocId(CATALOG));
    expect(shownIn(id)).toBe('conflict');
    workspaceOf(id).closeDoc(conflictDocId(CATALOG));
    expect(st().conflict).toBeNull();
    expect(shownIn(id)).toBeNull();
    expect(workspaceOf(folder).sessionDocs).toEqual([]);
    expect(workspaceOf(folder).activeDocId).toBe('overview');
  });

  it('저장소 탭의 커밋 파일 diff 는 폴더 탭에 생기지 않는다(폴더는 작업 트리 diff 만). 저장소 탭의 커밋 이동은 어느 탭의 에디터도 바꾸지 않는다', async () => {
    const { client, folder, id, st } = await shared();
    await st().openCommitFile('c'.repeat(40), LOGIN);
    expect(shownIn(id)).toBe('diff');
    expect(workspaceOf(folder).sessionDocs).toEqual([]);

    await st().openFile(LOGIN, false);
    workspaceOf(folder).revealDoc(worktreeDiffDocId(AUTH));
    vi.spyOn(client, 'findRow').mockResolvedValue(2);
    await st().jumpToCommit('e'.repeat(40));
    // W21: 로그는 Git 도구 창에 있으므로 저장소 탭의 diff 탭도 그대로다 (W20 은 그래프를 보이려 문서를 내렸다)
    expect(shownIn(id)).toBe('diff');
    expect(workspaceOf(folder).activeDocId).toBe(worktreeDiffDocId(AUTH));
  });
});
