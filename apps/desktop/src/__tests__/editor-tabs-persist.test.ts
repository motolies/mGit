import type { FsDirListing } from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EDITOR_TABS_LIMIT,
  EDITOR_TABS_SAVE_DELAY_MS,
  editorTabsSnapshot,
  existingFiles,
  flushEditorTabSaves,
  PREF_EDITOR_TABS,
  readSavedEditorTabs,
  restoreEditorTabs,
  retainSavedEditorTabs,
  watchEditorTabs,
  writeSavedEditorTabs,
} from '../store/editor-tabs-persist';
import { readPref, writePref } from '../store/prefs';
import {
  commitDiffDoc,
  createWorkspaceStore,
  fileViewDoc,
  fileViewDocId,
  OVERVIEW_DOC,
} from '../store/workspace-store';

/** 루트 기준 경로로 파일 보기 문서를 만든다 */
const file = (path: string) =>
  fileViewDoc({ path, name: path.split('/').pop() ?? path, repoPath: '/r', repoName: 'r' });

/** 디렉터리 → 파일 이름 목록으로 나열 응답을 흉내 낸다 (없는 디렉터리는 missing) */
function lister(tree: Record<string, string[]>) {
  return vi.fn(async (dir: string): Promise<FsDirListing> => {
    const names = tree[dir];
    if (!names) return { kind: 'missing' };
    return {
      kind: 'listed',
      entries: names.map((name) => ({
        name: name.replace(/\/$/, ''),
        kind: name.endsWith('/') ? 'dir' : 'file',
        size: 1,
        mtimeMs: 1,
        openable: true,
      })),
      total: names.length,
      truncated: false,
      nonUtf8Names: 0,
    };
  });
}

beforeEach(() => writePref(PREF_EDITOR_TABS, {}));
afterEach(() => vi.useRealTimers());

describe('편집기 탭 저장 형식', () => {
  it('고정한 파일 탭만 탭 순서대로, 보던 탭은 그것이 고정 파일 탭일 때만 저장한다', () => {
    const ws = createWorkspaceStore('folder');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(
      commitDiffDoc({
        repoPath: '/r',
        repoName: 'r',
        oid: 'c'.repeat(40),
        path: 'x.ts',
        oldPath: null,
        merge: false,
      }),
      'pinned',
    );
    ws.getState().openDoc(file('b.ts'), 'pinned');
    ws.getState().openDoc(file('preview.ts'), 'preview');
    const saved = editorTabsSnapshot(ws.getState());
    expect(saved).toEqual({
      files: [
        { path: 'a.ts', repoPath: '/r', repoName: 'r' },
        { path: 'b.ts', repoPath: '/r', repoName: 'r' },
      ],
      active: null,
    });
    ws.getState().activateDoc(fileViewDocId('b.ts'));
    expect(editorTabsSnapshot(ws.getState()).active).toBe('b.ts');
    // 저장하는 것은 경로와 저장소뿐이다 (편집 내용·초안은 없다)
    expect(Object.keys(saved.files[0] ?? {}).sort()).toEqual(['path', 'repoName', 'repoPath']);
  });

  it('상한을 넘으면 최근에 본 탭부터 남기고 탭 순서는 그대로 둔다', () => {
    const ws = createWorkspaceStore('repo');
    for (let i = 0; i < EDITOR_TABS_LIMIT + 5; i++)
      ws.getState().openDoc(file(`f${i}.ts`), 'pinned');
    // 맨 앞 탭을 다시 보면 그 탭은 남는다
    ws.getState().activateDoc(fileViewDocId('f0.ts'));
    const saved = editorTabsSnapshot(ws.getState());
    expect(saved.files).toHaveLength(EDITOR_TABS_LIMIT);
    expect(saved.files[0]?.path).toBe('f0.ts');
    expect(saved.files[1]?.path).toBe('f6.ts');
    expect(saved.files.at(-1)?.path).toBe(`f${EDITOR_TABS_LIMIT + 4}.ts`);
    expect(saved.active).toBe('f0.ts');
  });

  it('루트별로 저장·읽기·지우기를 하고, 다시 열지 못한 루트의 기록과 모양이 틀린 값은 버린다', () => {
    const tabs = { files: [{ path: 'a.ts', repoPath: null, repoName: null }], active: 'a.ts' };
    writeSavedEditorTabs('/one', tabs);
    writeSavedEditorTabs('/two', tabs);
    expect(readSavedEditorTabs('/one')).toEqual(tabs);
    writeSavedEditorTabs('/two', { files: [], active: null });
    expect(readSavedEditorTabs('/two')).toBeNull();
    writeSavedEditorTabs('/three', tabs);
    retainSavedEditorTabs(['/one']);
    expect(Object.keys(readPref(PREF_EDITOR_TABS, {}))).toEqual(['/one']);
    writePref(PREF_EDITOR_TABS, {
      '/bad': { files: 'nope' },
      '/mixed': { files: [{ path: 'ok.ts', repoPath: 3 }, { path: '' }, null], active: 7 },
    });
    expect(readSavedEditorTabs('/bad')).toBeNull();
    expect(readSavedEditorTabs('/mixed')).toEqual({
      files: [{ path: 'ok.ts', repoPath: null, repoName: null }],
      active: null,
    });
  });
});

describe('편집기 탭 저장 시점', () => {
  it('연달아 바뀌면 마지막 변경에서 잠시 뒤 한 번 저장하고, 해제하면 기다리던 저장을 버린다', () => {
    vi.useFakeTimers();
    const ws = createWorkspaceStore('repo');
    const stop = watchEditorTabs('/r', ws);
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(file('b.ts'), 'pinned');
    vi.advanceTimersByTime(EDITOR_TABS_SAVE_DELAY_MS - 1);
    expect(readSavedEditorTabs('/r')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(readSavedEditorTabs('/r')?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    ws.getState().closeDoc(fileViewDocId('a.ts'));
    stop();
    vi.advanceTimersByTime(EDITOR_TABS_SAVE_DELAY_MS);
    expect(readSavedEditorTabs('/r')?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('앱을 닫기 직전에는 기다리던 저장을 바로 하고, 미리보기 탭은 저장하지 않는다', () => {
    vi.useFakeTimers();
    const ws = createWorkspaceStore('repo');
    const stop = watchEditorTabs('/r', ws);
    ws.getState().openDoc(file('a.ts'), 'pinned');
    flushEditorTabSaves();
    expect(readSavedEditorTabs('/r')?.active).toBe('a.ts');
    ws.getState().openDoc(file('p.ts'), 'preview');
    flushEditorTabSaves();
    // 미리보기 탭을 보고 있으면 보던 탭은 없는 것으로 저장한다
    expect(readSavedEditorTabs('/r')).toEqual({
      files: [{ path: 'a.ts', repoPath: '/r', repoName: 'r' }],
      active: null,
    });
    stop();
  });
});

describe('편집기 탭 복원', () => {
  it('부모 디렉터리를 한 번씩 나열해 있는 파일만 고르고, 읽지 못한 디렉터리의 파일은 뺀다', async () => {
    const list = lister({ '': ['a.ts', 'sub/'], src: ['b.ts', 'c.ts'] });
    list.mockImplementationOnce(async () => {
      throw new Error('denied');
    });
    const found = await existingFiles(list, ['a.ts', 'sub', 'src/b.ts', 'src/c.ts', 'gone/x.ts']);
    // 첫 나열(루트)은 실패했다
    expect([...found].sort()).toEqual(['src/b.ts', 'src/c.ts']);
    expect(list).toHaveBeenCalledTimes(3);
    const again = await existingFiles(lister({ '': ['a.ts', 'sub/'] }), ['a.ts', 'sub']);
    expect([...again]).toEqual(['a.ts']);
  });

  it('사라진 파일은 조용히 건너뛰고 순서와 보던 탭을 되살리며, 폴더 탭의 개요는 그대로 둔다', async () => {
    const opened = vi.fn();
    const ws = createWorkspaceStore('folder', { onDocOpened: opened });
    const count = await restoreEditorTabs(
      ws,
      {
        files: [
          { path: 'a.ts', repoPath: '/r', repoName: 'r' },
          { path: 'gone.ts', repoPath: '/r', repoName: 'r' },
          { path: 'src/b.ts', repoPath: '/r', repoName: 'r' },
        ],
        active: 'src/b.ts',
      },
      (paths) => existingFiles(lister({ '': ['a.ts'], src: ['b.ts'] }), paths),
    );
    expect(count).toBe(2);
    const state = ws.getState();
    expect(state.docs.map((doc) => doc.id)).toEqual([
      OVERVIEW_DOC.id,
      fileViewDocId('a.ts'),
      fileViewDocId('src/b.ts'),
    ]);
    expect(state.docs.every((doc) => doc.pinned)).toBe(true);
    expect(state.activeDocId).toBe(fileViewDocId('src/b.ts'));
    expect(state.activeRepo).toBe('/r');
    // 복원은 사용자가 연 것이 아니다 (아래 도구 창 최대화를 풀지 않는다)
    expect(opened).not.toHaveBeenCalled();
    // 보던 탭이 사라졌으면 폴더 탭은 개요를 그대로 보이고, 저장소 탭은 마지막 탭을 보인다
    const folder = createWorkspaceStore('folder');
    await restoreEditorTabs(
      folder,
      { files: [{ path: 'a.ts', repoPath: null, repoName: null }], active: 'gone.ts' },
      async () => new Set(['a.ts']),
    );
    expect(folder.getState().activeDocId).toBe(OVERVIEW_DOC.id);
    const repo = createWorkspaceStore('repo');
    repo.getState().openDoc(file('mine.ts'), 'preview');
    await restoreEditorTabs(
      repo,
      {
        files: [
          { path: 'mine.ts', repoPath: '/r', repoName: 'r' },
          { path: 'z.ts', repoPath: '/r', repoName: 'r' },
        ],
        active: null,
      },
      async () => new Set(['mine.ts', 'z.ts']),
    );
    // 이미 열린 탭은 겹쳐 만들지 않는다
    expect(repo.getState().docs.map((doc) => doc.id)).toEqual([
      fileViewDocId('mine.ts'),
      fileViewDocId('z.ts'),
    ]);
    expect(repo.getState().activeDocId).toBe(fileViewDocId('mine.ts'));
  });
});

describe('편집기 분할의 저장·복원 (R3)', () => {
  /** 저장 한 칸 */
  const tab = (path: string) => ({ path, repoPath: '/r', repoName: 'r' });

  it('오른쪽 그룹의 고정 파일 탭·보던 탭과 왼쪽 폭을 저장하고, 나누기 전 형식은 그룹 하나로 읽는다', () => {
    const ws = createWorkspaceStore('repo');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    ws.getState().openDoc(file('b.ts'), 'pinned');
    ws.getState().splitDoc(fileViewDocId('b.ts'), 'main');
    ws.getState().openDoc(file('peek.ts'), 'preview');
    ws.getState().setSplitRatio(35);
    expect(editorTabsSnapshot(ws.getState())).toEqual({
      files: [tab('a.ts'), tab('b.ts')],
      active: 'b.ts',
      // 미리보기 탭은 저장하지 않는다 — 보던 탭이 미리보기면 오른쪽의 보던 탭은 없다
      side: { files: [tab('b.ts')], active: null },
      ratio: 35,
    });
    // 기본 폭·나누지 않음은 예전 형식 그대로다
    const plain = createWorkspaceStore('repo');
    plain.getState().openDoc(file('a.ts'), 'pinned');
    expect(editorTabsSnapshot(plain.getState())).toEqual({ files: [tab('a.ts')], active: 'a.ts' });

    // 예전 형식·틀린 오른쪽 그룹·숫자가 아닌 폭은 그룹 하나로 읽는다
    writePref(PREF_EDITOR_TABS, {
      '/old': { files: [tab('a.ts')], active: 'a.ts' },
      '/bad': { files: [tab('a.ts')], active: null, side: { files: 'x' }, ratio: 'wide' },
      '/new': {
        files: [tab('a.ts')],
        active: null,
        side: { files: [tab('b.ts')], active: 'b.ts' },
        ratio: 40,
      },
    });
    expect(readSavedEditorTabs('/old')).toEqual({ files: [tab('a.ts')], active: 'a.ts' });
    expect(readSavedEditorTabs('/bad')).toEqual({ files: [tab('a.ts')], active: null });
    expect(readSavedEditorTabs('/new')?.side).toEqual({ files: [tab('b.ts')], active: 'b.ts' });
    expect(readSavedEditorTabs('/new')?.ratio).toBe(40);
  });

  it('나누기·폭이 바뀌어도 잠시 뒤 저장한다', () => {
    vi.useFakeTimers();
    const ws = createWorkspaceStore('repo');
    ws.getState().openDoc(file('a.ts'), 'pinned');
    const off = watchEditorTabs('/root', ws);
    ws.getState().splitDoc(fileViewDocId('a.ts'), 'main');
    ws.getState().setSplitRatio(60);
    vi.advanceTimersByTime(EDITOR_TABS_SAVE_DELAY_MS);
    expect(readSavedEditorTabs('/root')).toMatchObject({
      side: { files: [tab('a.ts')], active: 'a.ts' },
      ratio: 60,
    });
    off();
  });

  it('오른쪽 그룹과 폭을 되살리고, 왼쪽 파일이 모두 사라졌으면 오른쪽 탭이 왼쪽으로 온다', async () => {
    const ws = createWorkspaceStore('repo');
    const count = await restoreEditorTabs(
      ws,
      {
        files: [tab('a.ts')],
        active: 'a.ts',
        side: { files: [tab('gone.ts'), tab('b.ts')], active: 'b.ts' },
        ratio: 30,
      },
      async () => new Set(['a.ts', 'b.ts']),
    );
    expect(count).toBe(2);
    const state = ws.getState();
    expect(state.docs.map((doc) => doc.id)).toEqual([fileViewDocId('a.ts')]);
    expect(state.split?.docs.map((doc) => doc.id)).toEqual([fileViewDocId('b.ts')]);
    expect(state.split?.activeDocId).toBe(fileViewDocId('b.ts'));
    expect([state.splitRatio, state.focusedGroup]).toEqual([30, 'main']);

    const lost = createWorkspaceStore('repo');
    await restoreEditorTabs(
      lost,
      { files: [tab('gone.ts')], active: null, side: { files: [tab('b.ts')], active: 'b.ts' } },
      async () => new Set(['b.ts']),
    );
    expect(lost.getState().split).toBeNull();
    expect(lost.getState().docs.map((doc) => doc.id)).toEqual([fileViewDocId('b.ts')]);
  });
});
