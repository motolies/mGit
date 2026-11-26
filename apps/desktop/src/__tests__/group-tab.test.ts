import {
  createNullClient,
  type FolderOpened,
  type FsDirListing,
  type GroupInfo,
  type GroupListItem,
  type IpcClient,
  type SessionEvent,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActionContext, buildActions, groupOpenActions } from '../actions';
import { filesStamp } from '../features/search/file-list';
import { useSearchPanel } from '../features/search/search-state';
import { createAppStore } from '../store/app-store';
import {
  flushEditorTabSaves,
  PREF_EDITOR_TABS,
  readSavedEditorTabs,
  writeSavedEditorTabs,
} from '../store/editor-tabs-persist';
import { FileEditorStore } from '../store/file-editor-store';
import { createFolderStore, selectedRepoPathsIn } from '../store/folder-store';
import { repoToRootIn, rootToRepoIn } from '../store/fs-path';
import { notifyHub } from '../store/notify';
import { writePref } from '../store/prefs';
import { readRecentFiles, recentFilesKey } from '../store/recent-files';
import { dirSpace, groupIdOf, groupKey, groupSpace, isGroupKey } from '../store/root-space';
import {
  clearSessionRegistry,
  disposeFolder,
  getFolderStore,
  getWorkspaceStore,
  registerFolder,
} from '../store/session-registry';
import { fileViewDoc, fileViewDocId } from '../store/workspace-store';

// 가상 그룹 탭 (MR-13 M2): 별칭 공간의 왕복, 그룹 탭 열기·복원·편집, 대시보드 선택과 일괄 대상, 검색 막기

/** 멤버 셋: 다른 곳의 api·web 과 api 와 이름 앞부분이 같은 형제 api-v2, 사라진 legacy */
const GROUP: GroupInfo = {
  id: 'g000000000001',
  name: 'Work',
  members: [
    { alias: 'api', path: '/w/api', state: 'present', kind: 'standalone' },
    { alias: 'web', path: '/x/team/web', state: 'present', kind: 'standalone' },
    { alias: 'api-v2', path: '/w/api-v2', state: 'present', kind: 'worktree' },
    { alias: 'legacy', path: '/old/legacy', state: 'missing', kind: null },
  ],
};
const KEY = 'mgit-group:g000000000001';

describe('groupSpace — 별칭 공간 왕복', () => {
  const space = groupSpace(GROUP);

  it('키는 그룹 키이고 열 루트 디렉터리가 없다', () => {
    expect(space.key).toBe(KEY);
    expect(space.dir).toBeNull();
    expect(isGroupKey(space.key)).toBe(true);
    expect(groupKey(GROUP.id)).toBe(KEY);
    expect(groupIdOf(KEY)).toBe(GROUP.id);
    expect(groupIdOf('/w/acme')).toBeNull();
  });

  /** [상대 경로, 절대 경로 (없으면 null)] */
  const TO_ABS: [string, string | null][] = [
    ['', null],
    ['api', '/w/api'],
    ['api/src/Main.java', '/w/api/src/Main.java'],
    ['web/README.md', '/x/team/web/README.md'],
    ['api-v2/a.ts', '/w/api-v2/a.ts'],
    ['legacy/x', '/old/legacy/x'],
    ['nope', null],
    ['nope/a.ts', null],
    ['API/a.ts', null],
  ];
  it.each(TO_ABS)('toAbs(%j) = %j', (rel, abs) => {
    expect(space.toAbs(rel)).toBe(abs);
  });

  /** [절대 경로, 상대 경로 (밖이면 null)] */
  const TO_REL: [string, string | null][] = [
    ['/w/api', 'api'],
    ['/w/api/', 'api'],
    ['/w/api/src/Main.java', 'api/src/Main.java'],
    ['/w/api-v2', 'api-v2'],
    ['/w/api-v2/a.ts', 'api-v2/a.ts'],
    ['/x/team/web/docs', 'web/docs'],
    ['/w', null],
    ['/w/apix', null],
    ['/x/team', null],
    ['/elsewhere/a', null],
  ];
  it.each(TO_REL)('toRel(%j) = %j', (abs, rel) => {
    expect(space.toRel(abs)).toBe(rel);
  });

  it('맨 위가 아닌 모든 상대 경로는 절대 경로를 거쳐 그대로 돌아온다', () => {
    for (const [rel, abs] of TO_ABS) {
      if (abs !== null) expect(space.toRel(abs)).toBe(rel);
    }
  });

  it('저장소 경로 변환이 별칭 공간을 따른다 (트리 경로 ↔ 저장소 기준 경로)', () => {
    const repos = ['/w/api', '/x/team/web'];
    expect(repoToRootIn(space, '/x/team/web', 'src/a.ts')).toBe('web/src/a.ts');
    expect(repoToRootIn(space, '/w/api', '')).toBe('api');
    expect(rootToRepoIn(space, repos, 'web/src/a.ts')).toEqual({
      repoPath: '/x/team/web',
      path: 'src/a.ts',
    });
    expect(rootToRepoIn(space, repos, '')).toBeNull();
  });
});

describe('대시보드 선택 ↔ 일괄 대상 (그룹)', () => {
  it('트리에서 고른 별칭 행(저장소 행)만 일괄 대상이 되고, 저장소 안 항목·맨 위는 대상이 아니다', () => {
    const repos = [
      { path: '/w/api', kind: 'standalone' as const },
      { path: '/x/team/web', kind: 'standalone' as const },
    ];
    const space = groupSpace(GROUP);
    expect(selectedRepoPathsIn(space, repos, { api: true, 'web/src': true, '': true })).toEqual([
      '/w/api',
    ]);
    expect(selectedRepoPathsIn(space, repos, { api: true, web: true })).toEqual([
      '/w/api',
      '/x/team/web',
    ]);
  });
});

describe('그룹 폴더 스토어', () => {
  it('열기 응답의 그룹으로 공간·이름을 정하고, groupChanged 는 멤버가 바뀔 때만 공간을 새로 만든다', () => {
    const opened: FolderOpened = { session: 9401, path: KEY, repos: [], group: GROUP };
    const store = createFolderStore(opened, createNullClient());
    const first = store.getState().space;
    expect(first.key).toBe(KEY);
    expect(first.toAbs('api')).toBe('/w/api');
    expect(store.getState().name).toBe('Work');
    expect(store.getState().group).toBe(GROUP);
    // 상태만 바뀌면(사라짐) 공간은 그대로
    const missing: GroupInfo = {
      ...GROUP,
      members: GROUP.members.map((m) =>
        m.alias === 'web' ? { ...m, state: 'missing', kind: null } : m,
      ),
    };
    store.getState().applyEvent({ type: 'groupChanged', session: 9401, group: missing });
    expect(store.getState().space).toBe(first);
    expect(store.getState().group?.members[1]?.state).toBe('missing');
    // 멤버 위치가 바뀌면 새 공간
    const moved: GroupInfo = {
      ...GROUP,
      members: GROUP.members.map((m) => (m.alias === 'web' ? { ...m, path: '/y/web' } : m)),
    };
    store.getState().applyEvent({ type: 'groupChanged', session: 9401, group: moved });
    expect(store.getState().space).not.toBe(first);
    expect(store.getState().space.toAbs('web/a')).toBe('/y/web/a');
  });

  it('⌘P 목록 표지는 그룹 멤버 상태가 바뀌면(groupChanged) 달라져 다시 받게 한다', () => {
    const store = createFolderStore(
      { session: 9403, path: KEY, repos: [], group: GROUP },
      createNullClient(),
    );
    registerFolder(9403, store);
    try {
      const before = filesStamp(9403);
      expect(filesStamp(9403)).toEqual(before);
      store.getState().applyEvent({
        type: 'groupChanged',
        session: 9403,
        group: {
          ...GROUP,
          members: GROUP.members.map((m) =>
            m.alias === 'web' ? { ...m, state: 'missing' as const, kind: null } : m,
          ),
        },
      });
      expect(filesStamp(9403)).not.toEqual(before);
    } finally {
      disposeFolder(9403);
    }
  });

  it('폴더 탭은 지금처럼 디렉터리 공간이고 그룹이 없다 (회귀)', () => {
    const store = createFolderStore(
      { session: 9402, path: '/w/acme', repos: [] },
      createNullClient(),
    );
    expect(store.getState().group).toBeNull();
    expect(store.getState().space.toAbs('api')).toBe(dirSpace('/w/acme').toAbs('api'));
    expect(store.getState().name).toBe('acme');
  });
});

/** 그룹 하나를 아는 가짜 클라이언트: 열면 세션 id 를 새로 주고, 멤버 디렉터리를 나열한다 */
function groupClient(tabs: string[]) {
  let next = 100;
  const listing = (names: string[]): FsDirListing => ({
    kind: 'listed',
    entries: names.map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 1, openable: true })),
    total: names.length,
    truncated: false,
    nonUtf8Names: 0,
  });
  const disk: Record<string, string[]> = { '': ['api', 'web'], api: ['a.ts'], 'web/src': ['b.ts'] };
  let item: GroupListItem = {
    id: GROUP.id,
    name: GROUP.name,
    members: GROUP.members,
    pinned: false,
    lastOpenedAt: 0,
  };
  // 마지막으로 연 그룹 세션과 그 이벤트 채널 (고치기를 코어처럼 그 자리에서 알린다)
  let opened: { session: number; emit: (event: SessionEvent) => void } | null = null;
  const repos = [
    { path: '/w/api', kind: 'standalone' as const },
    { path: '/x/team/web', kind: 'standalone' as const },
  ];
  const c: IpcClient = {
    ...createNullClient(),
    gitVersion: async () => ({ version: '2.54.0', path: '/usr/bin/git' }),
    openTabsGet: vi.fn(async () => tabs),
    openTabsSet: vi.fn(async () => {}),
    takeStartupPaths: vi.fn(async () => []),
    groupsList: vi.fn(async () => [item]),
    openGroup: vi.fn(async (id: string, onEvent): Promise<FolderOpened> => {
      opened = { session: next++, emit: onEvent };
      return {
        session: opened.session,
        path: `mgit-group:${id}`,
        repos,
        group: { id: item.id, name: item.name, members: item.members },
      };
    }),
    groupUpdate: vi.fn(async (_id, update) => {
      const before = JSON.stringify([item.name, item.members]);
      item = { ...item, ...(update.name ? { name: update.name } : {}) };
      if (update.pinned != null) item = { ...item, pinned: update.pinned };
      if (opened && JSON.stringify([item.name, item.members]) !== before) {
        const { session, emit } = opened;
        emit({ type: 'folderRescanned', session, repos });
        emit({
          type: 'groupChanged',
          session,
          group: { id: item.id, name: item.name, members: item.members },
        });
      }
      return item;
    }),
    closeFolder: vi.fn(async () => {}),
    openRepo: vi.fn(async () => {
      throw { kind: 'notARepository', path: '' };
    }),
    fsListDir: vi.fn(async (_s: number, dir: string) =>
      disk[dir] ? listing(disk[dir] ?? []) : { kind: 'missing' as const },
    ),
  };
  return c;
}

/** 뒤에서 도는 복원(나열 응답)이 끝날 때까지 기다린다 */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((done) => setTimeout(done, 0));
}

/** 그룹 탭의 세션 id */
function groupTab(store: ReturnType<typeof createAppStore>): number {
  const state = store.getState();
  const id = state.sessionOrder.find((sid) => state.sessions[sid]?.path === KEY);
  if (id === undefined) throw new Error('그룹 탭이 없다');
  return id;
}

describe('그룹 탭 열기·복원·편집', () => {
  beforeEach(() => {
    writePref(PREF_EDITOR_TABS, {});
    writePref(recentFilesKey(KEY), []);
  });
  afterEach(() => {
    clearSessionRegistry();
  });

  it('저장한 탭 목록의 그룹 키는 그룹으로 열고(폴더 탭 종류·그룹 이름), 그 키로 탭 목록을 다시 저장한다', async () => {
    const c = groupClient([]);
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().openPaths([KEY]);
    expect(c.openGroup).toHaveBeenCalledWith(GROUP.id, expect.any(Function));
    expect(c.openRepo).not.toHaveBeenCalled();
    const id = groupTab(store);
    expect(store.getState().sessions[id]).toMatchObject({
      kind: 'folder',
      path: KEY,
      name: 'Work',
    });
    expect(c.openTabsSet).toHaveBeenLastCalledWith([KEY]);
    expect(getFolderStore(id)?.getState().space.key).toBe(KEY);
    // 다시 열면 같은 탭 (코어가 같은 세션을 돌려주지 않아도 앱은 경로로 막지 않는다 — 여기서는 새 세션)
    await store.getState().openGroupAt(GROUP.id);
    expect(c.openGroup).toHaveBeenCalledTimes(2);
  });

  it('재시작하면 그룹 탭과 고정 파일 탭(별칭 경로)·최근 파일이 그룹 키로 복원된다', async () => {
    writeSavedEditorTabs(KEY, {
      files: [
        { path: 'api/a.ts', repoPath: '/w/api', repoName: 'api' },
        { path: 'web/src/b.ts', repoPath: '/x/team/web', repoName: 'web' },
        { path: 'api/gone.ts', repoPath: '/w/api', repoName: 'api' },
      ],
      active: 'web/src/b.ts',
    });
    const c = groupClient([KEY]);
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().bootstrap();
    await settle();
    const ws = getWorkspaceStore(groupTab(store))?.getState();
    // 폴더 탭처럼 개요 문서가 늘 있고, 그 뒤에 되살린 파일 탭 (사라진 파일은 빠진다)
    expect(ws?.docs.filter((doc) => doc.kind === 'file').map((doc) => doc.id)).toEqual([
      fileViewDocId('api/a.ts'),
      fileViewDocId('web/src/b.ts'),
    ]);
    expect(ws?.activeDocId).toBe(fileViewDocId('web/src/b.ts'));
    expect(readRecentFiles(KEY)).toEqual(['web/src/b.ts']);
    // 복원 뒤의 탭 변경은 그룹 키로 저장한다
    ws?.openDoc(
      fileViewDoc({ path: 'api/a.ts', name: 'a.ts', repoPath: '/w/api', repoName: 'api' }),
      'pinned',
    );
    flushEditorTabSaves();
    expect(readSavedEditorTabs(KEY)?.files.map((f) => f.path)).toContain('api/a.ts');
  });

  it('열린 그룹의 이름을 바꾸면 탭을 연 채로 고치고(고정 파일 탭 유지) 탭 이름이 groupChanged 로 바뀐다 (M4)', async () => {
    const c = groupClient([]);
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().loadGroups();
    await store.getState().openGroupAt(GROUP.id);
    const first = groupTab(store);
    const ws = getWorkspaceStore(first);
    ws?.getState().openDoc(
      fileViewDoc({ path: 'api/a.ts', name: 'a.ts', repoPath: '/w/api', repoName: 'api' }),
      'pinned',
    );
    expect(await store.getState().updateGroup(GROUP.id, { pinned: true })).toBe(true);
    expect(groupTab(store)).toBe(first);
    expect(await store.getState().updateGroup(GROUP.id, { name: 'Renamed' })).toBe(true);
    expect(c.closeFolder).not.toHaveBeenCalled();
    expect(c.openGroup).toHaveBeenCalledTimes(1);
    expect(c.groupUpdate).toHaveBeenLastCalledWith(GROUP.id, { name: 'Renamed' });
    expect(groupTab(store)).toBe(first);
    expect(store.getState().sessions[first]?.name).toBe('Renamed');
    expect(getFolderStore(first)?.getState().name).toBe('Renamed');
    expect(ws?.getState().docs.some((doc) => doc.id === fileViewDocId('api/a.ts'))).toBe(true);
  });

  it('그룹 탭의 터미널은 열 루트가 없어 활성 저장소에서, 그것도 없으면 홈에서 연다', async () => {
    const c = groupClient([]);
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().openGroupAt(GROUP.id);
    store.getState().openTerminal();
    expect(store.getState().terminals.at(-1)?.cwd).toBe('~');
    getWorkspaceStore(groupTab(store))?.getState().setActiveRepo('/x/team/web');
    store.getState().openTerminal();
    expect(store.getState().terminals.at(-1)?.cwd).toBe('/x/team/web');
  });
});

describe('같은 파일을 폴더 탭과 그룹 탭에서 편집', () => {
  it('트리 경로가 달라도 코어의 실제 파일 식별자가 같으면 편집 문서는 하나다', async () => {
    const store = new FileEditorStore();
    const read = vi.fn(async (_session: number, path: string) => ({
      kind: 'text' as const,
      text: 'body\n',
      size: 5,
      // 코어는 실제 경로로 식별자를 만든다: 폴더 `/x` 의 `team/web/src/b.ts` 와 그룹의 `web/src/b.ts` 는 같은 파일
      fileKey: path.endsWith('web/src/b.ts') ? 'real:/x/team/web/src/b.ts' : `real:${path}`,
      revision: '1',
      bom: false,
      lineEnding: 'lf' as const,
    }));
    const client = { ...createNullClient(), fsReadEditableFile: read };
    const inFolder = await store.open(client, 1, 'team/web/src/b.ts');
    const inGroup = await store.open(client, 2, 'web/src/b.ts');
    expect(inGroup).toBe(inFolder);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('그룹 탭의 동작', () => {
  /** 그룹 탭(또는 폴더 탭)의 동작 컨텍스트 */
  function groupCtx(groupId: string | null, root: string | null): ActionContext {
    const app = {
      activeSessionId: 2,
      sessionOrder: [2],
      isOpening: false,
      theme: 'system',
      shortcutOverrides: {},
      dock: { tool: null, maximized: false, gitTab: 'console' },
      setGroupDialog: vi.fn(),
      openExternal: vi.fn(async () => {}),
    } as unknown as ActionContext['app'];
    return {
      app,
      session: null,
      tabKind: 'folder',
      openQuickSwitch: vi.fn(),
      startClone: vi.fn(),
      startInit: vi.fn(),
      promptBranch: vi.fn(),
      promptCompare: vi.fn(),
      promptColumns: vi.fn(),
      folder: {
        enabled: true,
        root,
        groupId,
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        createBranch: vi.fn(),
        checkout: vi.fn(),
        runCommand: vi.fn(),
      },
    };
  }
  afterEach(() => {
    useSearchPanel.getState().close(false);
    notifyHub.setHandler(null);
  });

  it('그룹 탭도 파일 찾기·최근 파일·내용 검색 창을 연다 (M3)', () => {
    const notices: string[] = [];
    notifyHub.setHandler((n) => notices.push(n.title));
    const byId = Object.fromEntries(buildActions(groupCtx(GROUP.id, null)).map((a) => [a.id, a]));
    byId['workspace.quickOpen']?.run();
    expect(useSearchPanel.getState().mode).toBe('files');
    byId['workspace.recentFiles']?.run();
    expect(useSearchPanel.getState().mode).toBe('recent');
    byId['workspace.searchContent']?.run();
    expect(useSearchPanel.getState().mode).toBe('content');
    expect(notices).toEqual([]);
  });

  it('그룹 탭은 일괄 동작이 그대로 켜지고 외부 열기는 활성 저장소가 없으면 꺼지며, 그룹 편집이 켜진다', () => {
    const c = groupCtx(GROUP.id, null);
    const byId = Object.fromEntries(buildActions(c).map((a) => [a.id, a]));
    expect(byId['sync.fetch']?.enabled).toBe(true);
    expect(byId['external.terminal']?.enabled).toBe(false);
    expect(byId['group.fromFolder']?.enabled).toBe(false);
    expect(byId['group.edit']?.enabled).toBe(true);
    byId['group.edit']?.run();
    expect(c.app.setGroupDialog).toHaveBeenCalledWith({ mode: 'edit', id: GROUP.id });
    const withRepo = Object.fromEntries(
      buildActions(groupCtx(GROUP.id, '/w/api')).map((a) => [a.id, a]),
    );
    expect(withRepo['external.terminal']?.enabled).toBe(true);
  });

  it('폴더 탭은 검색이 그대로이고 "이 폴더로 그룹 만들기" 가 폴더 이름·경로로 대화상자를 연다', () => {
    const c = groupCtx(null, '/w/acme');
    const byId = Object.fromEntries(buildActions(c).map((a) => [a.id, a]));
    byId['workspace.quickOpen']?.run();
    expect(useSearchPanel.getState().mode).toBe('files');
    expect(byId['group.edit']?.enabled).toBe(false);
    byId['group.fromFolder']?.run();
    expect(c.app.setGroupDialog).toHaveBeenCalledWith({
      mode: 'create',
      name: 'acme',
      paths: ['/w/acme'],
    });
  });

  it('팔레트의 그룹 열기 항목은 그룹마다 하나다', () => {
    const open = vi.fn();
    const list = groupOpenActions([{ id: 'g1', name: 'A' }], open, true);
    expect(list.map((a) => [a.id, a.title])).toEqual([['group.open.g1', S.group.openNamed('A')]]);
    list[0]?.run();
    expect(open).toHaveBeenCalledWith('g1');
  });
});
