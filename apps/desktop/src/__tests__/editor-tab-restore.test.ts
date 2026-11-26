import {
  createNullClient,
  emptyRepoState,
  type FsDirListing,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import {
  flushEditorTabSaves,
  PREF_EDITOR_TABS,
  readSavedEditorTabs,
  writeSavedEditorTabs,
} from '../store/editor-tabs-persist';
import { writePref } from '../store/prefs';
import { readRecentFiles, recentFilesKey } from '../store/recent-files';
import { clearSessionRegistry, getWorkspaceStore } from '../store/session-registry';
import { fileViewDoc, fileViewDocId } from '../store/workspace-store';

const HEAD = 'a'.repeat(40);

/** 루트 → 디렉터리 → 파일 이름. 저장소를 열고 그 루트의 디렉터리를 나열하는 가짜 클라이언트 */
function client(tabs: string[], disk: Record<string, Record<string, string[]>>) {
  let next = 1;
  const roots = new Map<number, string>();
  const opened = (path: string): RepoOpened => {
    const session = next++;
    roots.set(session, path);
    return {
      session,
      alreadyOpen: false,
      nestedRepos: [],
      superproject: null,
      info: {
        workTree: path,
        gitDir: `${path}/.git`,
        commonDir: `${path}/.git`,
        objectFormat: 'sha1',
        head: { state: 'attached', branch: 'main', oid: HEAD },
        commitGraph: { present: false },
        shallow: false,
      },
      state: emptyRepoState({ state: 'attached', branch: 'main', oid: HEAD }),
    };
  };
  const c: IpcClient = {
    ...createNullClient(),
    gitVersion: async () => ({ version: '2.54.0', path: '/usr/bin/git' }),
    openRepo: vi.fn(async (path: string) => {
      if (!disk[path]) throw { kind: 'notARepo', path };
      return opened(path);
    }),
    closeRepo: vi.fn(async () => {}),
    openTabsGet: vi.fn(async () => tabs),
    openTabsSet: vi.fn(async () => {}),
    takeStartupPaths: vi.fn(async () => []),
    fsListDir: vi.fn(async (session: number, dir: string): Promise<FsDirListing> => {
      const names = disk[roots.get(session) ?? '']?.[dir];
      if (!names) return { kind: 'missing' };
      return {
        kind: 'listed',
        entries: names.map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 1, openable: true })),
        total: names.length,
        truncated: false,
        nonUtf8Names: 0,
      };
    }),
  };
  return c;
}

/** 뒤에서 도는 복원(나열 응답)이 끝날 때까지 기다린다 */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
}

/** 경로로 탭 id 를 찾는다 */
function idOf(store: ReturnType<typeof createAppStore>, path: string): number {
  const state = store.getState();
  const id = state.sessionOrder.find((sid) => state.sessions[sid]?.path === path);
  if (id === undefined) throw new Error(`no tab ${path}`);
  return id;
}

const saved = (paths: string[], active: string | null) => ({
  files: paths.map((path) => ({ path, repoPath: '/r1', repoName: 'r1' })),
  active,
});

beforeEach(() => {
  writePref(PREF_EDITOR_TABS, {});
  writePref(recentFilesKey('/r1'), []);
});
afterEach(() => {
  clearSessionRegistry();
});

describe('재시작 뒤 편집기 탭 복원', () => {
  it('다시 연 저장소 탭의 파일 탭을 순서·보던 탭 그대로 되살리고, 사라진 파일과 열지 못한 루트의 기록은 버린다', async () => {
    writeSavedEditorTabs('/r1', saved(['a.ts', 'gone.ts', 'src/b.ts'], 'src/b.ts'));
    writeSavedEditorTabs('/missing-root', saved(['x.ts'], null));
    const c = client(['/r1', '/r2', '/missing-root'], {
      '/r1': { '': ['a.ts'], src: ['b.ts'] },
      '/r2': { '': [] },
    });
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().bootstrap();
    await settle();
    const ws = getWorkspaceStore(idOf(store, '/r1'))?.getState();
    expect(ws?.docs.map((doc) => doc.id)).toEqual([
      fileViewDocId('a.ts'),
      fileViewDocId('src/b.ts'),
    ]);
    expect(ws?.docs.every((doc) => doc.pinned)).toBe(true);
    expect(ws?.activeDocId).toBe(fileViewDocId('src/b.ts'));
    expect(getWorkspaceStore(idOf(store, '/r2'))?.getState().docs).toEqual([]);
    // 복원만으로는 기록을 다시 쓰지 않는다 — 탭 저장은 복원을 마친 뒤 걸린다 (사라진 파일은 다음 변경 때 빠진다)
    flushEditorTabSaves();
    expect(readSavedEditorTabs('/r1')).toEqual(saved(['a.ts', 'gone.ts', 'src/b.ts'], 'src/b.ts'));
    expect(readSavedEditorTabs('/missing-root')).toBeNull();
    // 보이게 된 파일은 최근 파일에 오른다
    expect(readRecentFiles('/r1')).toEqual(['src/b.ts']);
    // 파일 내용은 읽지 않고 디렉터리만 나열했다
    expect(c.fsListDir).toHaveBeenCalledTimes(2);
  });

  it('편집기를 나눠 두었으면 오른쪽 그룹과 폭도 되살린다 (R3)', async () => {
    writeSavedEditorTabs('/r1', {
      ...saved(['a.ts'], 'a.ts'),
      side: saved(['gone.ts', 'src/b.ts'], 'src/b.ts'),
      ratio: 30,
    });
    const c = client(['/r1'], { '/r1': { '': ['a.ts'], src: ['b.ts'] } });
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().bootstrap();
    await settle();
    const ws = getWorkspaceStore(idOf(store, '/r1'))?.getState();
    expect(ws?.docs.map((doc) => doc.id)).toEqual([fileViewDocId('a.ts')]);
    expect(ws?.split?.docs.map((doc) => doc.id)).toEqual([fileViewDocId('src/b.ts')]);
    expect(ws?.split?.activeDocId).toBe(fileViewDocId('src/b.ts'));
    expect([ws?.splitRatio, ws?.focusedGroup]).toEqual([30, 'main']);
    // 두 그룹에서 보이게 된 파일이 모두 최근 파일에 오른다
    expect([...readRecentFiles('/r1')].sort()).toEqual(['a.ts', 'src/b.ts']);
  });

  it('복원이 끝난 뒤의 탭 변경은 저장하고, 사용자가 탭을 닫으면 그 루트의 기록을 지운다', async () => {
    writeSavedEditorTabs('/r1', saved(['a.ts'], 'a.ts'));
    const c = client(['/r1'], { '/r1': { '': ['a.ts', 'c.ts'] } });
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().bootstrap();
    await settle();
    const id = idOf(store, '/r1');
    getWorkspaceStore(id)
      ?.getState()
      .openDoc(
        fileViewDoc({ path: 'c.ts', name: 'c.ts', repoPath: '/r1', repoName: 'r1' }),
        'pinned',
      );
    flushEditorTabSaves();
    expect(readSavedEditorTabs('/r1')?.files.map((file) => file.path)).toEqual(['a.ts', 'c.ts']);
    expect(readSavedEditorTabs('/r1')?.active).toBe('c.ts');
    await store.getState().closeSession(id);
    flushEditorTabSaves();
    expect(readSavedEditorTabs('/r1')).toBeNull();
  });

  it('나열이 실패하면 그 탭만 건너뛰고 탭 저장은 그대로 시작한다', async () => {
    writeSavedEditorTabs('/r1', saved(['a.ts'], 'a.ts'));
    const c = client(['/r1'], { '/r1': { '': ['a.ts'] } });
    c.fsListDir = vi.fn(async () => {
      throw new Error('denied');
    });
    const store = createAppStore({ client: c, pickDirectory: async () => null });
    await store.getState().bootstrap();
    await settle();
    const ws = getWorkspaceStore(idOf(store, '/r1'));
    expect(ws?.getState().docs).toEqual([]);
    ws?.getState().openDoc(
      fileViewDoc({ path: 'n.ts', name: 'n.ts', repoPath: '/r1', repoName: 'r1' }),
      'pinned',
    );
    flushEditorTabSaves();
    expect(readSavedEditorTabs('/r1')?.files.map((file) => file.path)).toEqual(['n.ts']);
  });
});
