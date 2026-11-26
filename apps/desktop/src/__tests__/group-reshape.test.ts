import {
  createNullClient,
  type FolderOpened,
  type FsDirListing,
  type GroupListItem,
  type GroupMemberEdit,
  type GroupMemberInfo,
  type IpcClient,
  type SessionEvent,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readFavoriteOverrides,
  writeFavoriteOverrides,
} from '../features/branches/branch-favorites';
import { readRecentCommands, recentCommandsKey } from '../features/folder/recent-commands';
import { aliasError } from '../features/group/GroupDialog';
import { aliasProblem } from '../features/group/group-edits';
import { filesStamp } from '../features/search/file-list';
import { createAppStore } from '../store/app-store';
import {
  PREF_EDITOR_TABS,
  readSavedEditorTabs,
  writeSavedEditorTabs,
} from '../store/editor-tabs-persist';
import { useFileCloseStore } from '../store/file-editor-close';
import { fileEditors } from '../store/file-editor-store';
import { groupPathMove, type MemberChanges, memberChanges } from '../store/group-reshape';
import { type MovableTabs, remapFileDocs, remapTreePaths } from '../store/path-remap';
import { readPref, writePref } from '../store/prefs';
import { readRecentFiles, recentFilesKey } from '../store/recent-files';
import {
  forgetRootPrefs,
  movedRecentFiles,
  movedSavedTabs,
  timelineRepoWidthKey,
} from '../store/root-prefs';
import { getFolderStore, getWorkspaceStore } from '../store/session-registry';
import { type EditorDoc, fileViewDoc, fileViewDocId } from '../store/workspace-store';

// 그룹 관리 고도화 (MR-13 M4): 열린 그룹에 그 자리 반영, 별칭 바꾸기의 경로 옮기기, 그룹 삭제 시 기록 정리

/** 멤버 하나 (별칭·위치) */
const m = (alias: string, path: string): GroupMemberEdit => ({ alias, path });
const BEFORE = [m('api', '/w/api'), m('web', '/x/web'), m('old', '/o/old')];

/** 바뀜 표 하나를 읽기 쉬운 꼴로 */
function plain(changes: MemberChanges) {
  return {
    renamed: Object.fromEntries(changes.renamed),
    removed: [...changes.removed],
    relocated: [...changes.relocated],
  };
}

describe('memberChanges — 고치기 전후 멤버 견주기', () => {
  const CASES: [string, GroupMemberEdit[] | null, ReturnType<typeof plain>][] = [
    ['멤버를 고치지 않음', null, { renamed: {}, removed: [], relocated: [] }],
    ['그대로', BEFORE, { renamed: {}, removed: [], relocated: [] }],
    [
      '별칭만 바꿈 (같은 위치)',
      [m('backend', '/w/api'), m('web', '/x/web'), m('old', '/o/old')],
      { renamed: { api: 'backend' }, removed: [], relocated: [] },
    ],
    [
      '대소문자만 바꿈',
      [m('API', '/w/api'), m('web', '/x/web'), m('old', '/o/old')],
      { renamed: { api: 'API' }, removed: [], relocated: [] },
    ],
    [
      '뺌',
      [m('api', '/w/api'), m('old', '/o/old')],
      { renamed: {}, removed: ['web'], relocated: [] },
    ],
    [
      '위치 다시 지정 (같은 별칭, 새 위치)',
      [m('api', '/w/api'), m('web', '/y/web'), m('old', '/o/old')],
      { renamed: {}, removed: [], relocated: ['web'] },
    ],
    [
      '별칭 맞바꾸기',
      [m('web', '/w/api'), m('api', '/x/web'), m('old', '/o/old')],
      { renamed: { api: 'web', web: 'api' }, removed: [], relocated: [] },
    ],
    [
      '별칭을 바꾸고 옛 별칭을 새 저장소에 줌',
      [m('backend', '/w/api'), m('api', '/n/api'), m('web', '/x/web'), m('old', '/o/old')],
      { renamed: { api: 'backend' }, removed: [], relocated: [] },
    ],
    [
      '저장소 추가만',
      [...BEFORE, m('tools', '/t/tools')],
      { renamed: {}, removed: [], relocated: [] },
    ],
  ];
  it.each(CASES)('%s', (_name, after, expected) => {
    expect(plain(memberChanges(BEFORE, after))).toEqual(expected);
  });
});

describe('groupPathMove — 그룹 경로 옮기기', () => {
  const changes = memberChanges(BEFORE, [m('backend', '/w/api'), m('old', '/n/old')]);
  const move = groupPathMove(changes);
  const CASES: [string, string | null][] = [
    ['', ''],
    ['api', 'backend'],
    ['api/src/a.ts', 'backend/src/a.ts'],
    ['api-v2/x', 'api-v2/x'],
    ['API/x', 'API/x'],
    ['web', null],
    ['web/b.ts', null],
    // 위치를 바꾼 멤버의 기록은 같은 별칭으로 남는다
    ['old/c.ts', 'old/c.ts'],
    ['tools/d.ts', 'tools/d.ts'],
  ];
  it.each(CASES)('%j → %j', (path, expected) => {
    expect(move(path)).toBe(expected);
  });

  it('맞바꾼 별칭은 서로 섞이지 않는다', () => {
    const swap = groupPathMove(memberChanges(BEFORE, [m('web', '/w/api'), m('api', '/x/web')]));
    expect(swap('api/a')).toBe('web/a');
    expect(swap('web/b')).toBe('api/b');
  });
});

describe('저장한 기록의 경로 옮기기 (순수 함수)', () => {
  const move = groupPathMove(memberChanges(BEFORE, [m('backend', '/w/api'), m('old', '/o/old')]));
  const tab = (path: string) => ({ path, repoPath: null, repoName: null });

  it('편집기 탭: 옮기고, 사라진 탭은 빼고, 보던 탭도 옮긴다', () => {
    expect(
      movedSavedTabs(
        { files: [tab('api/a.ts'), tab('web/b.ts'), tab('old/c.ts')], active: 'api/a.ts' },
        move,
      ),
    ).toEqual({ files: [tab('backend/a.ts'), tab('old/c.ts')], active: 'backend/a.ts' });
  });

  it('편집기 탭: 보던 탭이 사라지면 보던 탭은 없고, 다 사라지면 기록이 없다', () => {
    expect(
      movedSavedTabs({ files: [tab('api/a.ts'), tab('web/b.ts')], active: 'web/b.ts' }, move),
    ).toEqual({ files: [tab('backend/a.ts')], active: null });
    expect(movedSavedTabs({ files: [tab('web/b.ts')], active: null }, move)).toBeNull();
    expect(movedSavedTabs(null, move)).toBeNull();
  });

  it('편집기 탭: 나눈 기록은 오른쪽 그룹도 옮기고 폭은 그대로, 왼쪽이 비면 오른쪽이 왼쪽이 된다 (R3)', () => {
    expect(
      movedSavedTabs(
        {
          files: [tab('api/a.ts')],
          active: 'api/a.ts',
          side: { files: [tab('web/b.ts'), tab('api/c.ts')], active: 'api/c.ts' },
          ratio: 30,
        },
        move,
      ),
    ).toEqual({
      files: [tab('backend/a.ts')],
      active: 'backend/a.ts',
      side: { files: [tab('backend/c.ts')], active: 'backend/c.ts' },
      ratio: 30,
    });
    expect(
      movedSavedTabs(
        {
          files: [tab('web/b.ts')],
          active: null,
          side: { files: [tab('api/c.ts')], active: null },
        },
        move,
      ),
    ).toEqual({ files: [tab('backend/c.ts')], active: null });
  });

  it('편집기 탭: 옮긴 결과 겹치면 앞의 것만 남긴다', () => {
    const swapInto = groupPathMove(memberChanges([m('a', '/a'), m('b', '/b')], [m('b', '/a')]));
    expect(movedSavedTabs({ files: [tab('a/x'), tab('b/x')], active: 'a/x' }, swapInto)).toEqual({
      files: [tab('b/x')],
      active: 'b/x',
    });
  });

  it('최근 파일: 옮기고 사라진 것은 빼며 겹치면 더 최근 것만 남긴다', () => {
    expect(movedRecentFiles(['api/a.ts', 'web/b.ts', 'backend/a.ts', 'old/c.ts'], move)).toEqual([
      'backend/a.ts',
      'old/c.ts',
    ]);
    expect(movedRecentFiles([], move)).toEqual([]);
  });
});

describe('path-remap — 열린 화면 상태 옮기기', () => {
  const file = (path: string, pinned = true): EditorDoc => ({
    ...fileViewDoc({ path, name: path.split('/').at(-1) ?? path, repoPath: null, repoName: null }),
    pinned,
  });
  const overview: EditorDoc = { id: 'overview', kind: 'overview', pinned: true };
  const move = groupPathMove(memberChanges(BEFORE, [m('backend', '/w/api'), m('old', '/o/old')]));
  const moveDoc = (doc: Extract<EditorDoc, { kind: 'file' }>) => {
    const path = move(doc.path);
    if (path === null) return null;
    return path === doc.path ? doc : { ...doc, id: fileViewDocId(path), path };
  };

  it('파일 탭을 옮기고 보던 탭·본 순서도 새 id 로 옮긴다', () => {
    const tabs: MovableTabs = {
      docs: [overview, file('api/a.ts'), file('web/b.ts'), file('old/c.ts')],
      activeDocId: fileViewDocId('api/a.ts'),
      recentDocIds: ['overview', fileViewDocId('web/b.ts'), fileViewDocId('api/a.ts')],
    };
    const next = remapFileDocs(tabs, moveDoc);
    expect(next.docs.map((d) => d.id)).toEqual([
      'overview',
      fileViewDocId('backend/a.ts'),
      fileViewDocId('old/c.ts'),
    ]);
    expect(next.activeDocId).toBe(fileViewDocId('backend/a.ts'));
    expect(next.recentDocIds).toEqual(['overview', fileViewDocId('backend/a.ts')]);
  });

  it('보던 파일 탭이 사라지면 첫 탭을 보고, 파일이 아닌 문서를 보던 중이면 그대로다', () => {
    const tabs: MovableTabs = {
      docs: [overview, file('web/b.ts')],
      activeDocId: fileViewDocId('web/b.ts'),
      recentDocIds: [],
    };
    expect(remapFileDocs(tabs, moveDoc).activeDocId).toBe('overview');
    expect(remapFileDocs({ ...tabs, activeDocId: 'overview' }, moveDoc).activeDocId).toBe(
      'overview',
    );
    expect(
      remapFileDocs({ ...tabs, activeDocId: 'worktreeDiff:/w/api' }, moveDoc).activeDocId,
    ).toBe('worktreeDiff:/w/api');
  });

  it('트리의 기준 행·범위 시작·선택·펼침을 옮기고 사라진 경로는 뺀다', () => {
    expect(
      remapTreePaths(
        {
          selected: 'api/src/a.ts',
          anchor: 'web/b.ts',
          selection: { 'api/src/a.ts': true, 'web/b.ts': true, '': true },
          expanded: { '': true, api: true, 'api/src': true, web: true, old: true },
        },
        move,
      ),
    ).toEqual({
      selected: 'backend/src/a.ts',
      anchor: null,
      selection: { 'backend/src/a.ts': true, '': true },
      expanded: { '': true, backend: true, 'backend/src': true, old: true },
    });
  });
});

describe('별칭 칸 검사 (대화상자)', () => {
  const CASES: [string, string[], 'invalid' | 'duplicate' | null][] = [
    ['api', ['web'], null],
    ['작업 폴더', [], null],
    ['.hidden', [], null],
    ['a.b', [], null],
    ['x'.repeat(255), [], null],
    ['', [], 'invalid'],
    ['.', [], 'invalid'],
    ['..', [], 'invalid'],
    ['.git', [], 'invalid'],
    ['.GIT', [], 'invalid'],
    ['a/b', [], 'invalid'],
    ['a\\b', [], 'invalid'],
    ['a\0b', [], 'invalid'],
    ['x'.repeat(256), [], 'invalid'],
    ['가'.repeat(86), [], 'invalid'],
    ['API', ['api'], 'duplicate'],
    ['web', ['api', 'Web'], 'duplicate'],
  ];
  it.each(CASES)('%j (다른 별칭 %j) → %j', (alias, others, expected) => {
    expect(aliasProblem(alias, others)).toBe(expected);
  });

  it('목록의 첫 문제를 문구로 알려 준다', () => {
    expect(aliasError([{ alias: 'api' }, { alias: 'web' }])).toBeNull();
    expect(aliasError([{ alias: 'api' }, { alias: 'a/b' }])).toBe(S.group.aliasInvalid('a/b'));
    expect(aliasError([{ alias: 'api' }, { alias: 'API' }])).toBe(S.group.aliasDuplicate('api'));
  });
});

// ── 앱 스토어: 열린 그룹 고치기 ─────────────────────────────────────────────────────────────

const ID = 'g0000000000a4';
const KEY = `mgit-group:${ID}`;

/** 디스크 (실제 경로 → 항목). 디렉터리는 `/` 로 끝나는 이름 */
const DISK: Record<string, string[]> = {
  '/w/api': ['src/'],
  '/w/api/src': ['a.ts'],
  '/x/web': ['b.ts'],
};

/**
 * 그룹 하나를 아는 가짜 코어: 열면 세션을 주고, 고치면 코어처럼 그 자리에서 `folderRescanned` → `groupChanged` 를 보낸다.
 * 파일 경로는 지금 멤버의 별칭으로 실제 경로를 찾는다 (별칭을 바꾸면 옛 별칭은 없다). 저장은 실패시킬 수 있다
 */
function groupCore(session: number) {
  let members: GroupMemberInfo[] = [
    { alias: 'api', path: '/w/api', state: 'present', kind: 'standalone' },
    { alias: 'web', path: '/x/web', state: 'present', kind: 'standalone' },
  ];
  let name = 'Work';
  let emit: ((event: SessionEvent) => void) | null = null;
  const state = { saveFails: false, lockedDuringUpdate: [] as boolean[] };
  const item = (): GroupListItem => ({ id: ID, name, members, pinned: false, lastOpenedAt: 0 });
  const repos = () => members.map((x) => ({ path: x.path, kind: 'standalone' as const }));
  /** 그룹 경로 → 실제 경로 (모르는 별칭이면 null) */
  const real = (path: string): string | null => {
    const [alias, ...rest] = path.split('/');
    const member = members.find((x) => x.alias === alias);
    return member ? [member.path, ...rest].join('/') : null;
  };
  const listing = (names: string[]): FsDirListing => ({
    kind: 'listed',
    entries: names.map((n) => ({
      name: n.replace(/\/$/, ''),
      kind: n.endsWith('/') ? ('dir' as const) : ('file' as const),
      size: 1,
      mtimeMs: 1,
      openable: true,
    })),
    total: names.length,
    truncated: false,
    nonUtf8Names: 0,
  });
  const client: IpcClient = {
    ...createNullClient(),
    gitVersion: async () => ({ version: '2.54.0', path: '/usr/bin/git' }),
    openTabsGet: vi.fn(async () => []),
    openTabsSet: vi.fn(async () => {}),
    groupsList: vi.fn(async () => [item()]),
    openGroup: vi.fn(async (_id: string, onEvent): Promise<FolderOpened> => {
      emit = onEvent;
      return { session, path: KEY, repos: repos(), group: { id: ID, name, members } };
    }),
    groupUpdate: vi.fn(async (_id, update) => {
      state.lockedDuringUpdate = fileEditors.documents(session).map((d) => !!d.mutationLocked);
      if (update.name) name = update.name;
      if (update.members) {
        members = update.members.map((x: GroupMemberEdit) => ({
          alias: x.alias,
          path: x.path,
          state: 'present' as const,
          kind: 'standalone' as const,
        }));
      }
      emit?.({ type: 'folderRescanned', session, repos: repos() });
      emit?.({ type: 'groupChanged', session, group: { id: ID, name, members } });
      return item();
    }),
    groupDelete: vi.fn(async () => {}),
    closeFolder: vi.fn(async () => {}),
    fsListDir: vi.fn(async (_s: number, dir: string) => {
      if (dir === '') return listing(members.map((x) => `${x.alias}/`));
      const abs = real(dir);
      const names = abs === null ? undefined : DISK[abs];
      if (names === undefined) {
        if (abs === null) throw new Error(`rejected: ${dir}`);
        return { kind: 'missing' as const };
      }
      return listing(names);
    }),
    fsReadEditableFile: vi.fn(async (_s: number, path: string) => {
      const abs = real(path);
      if (abs === null) throw new Error(`rejected: ${path}`);
      return {
        kind: 'text' as const,
        text: 'body\n',
        size: 5,
        fileKey: `real:${abs}`,
        revision: '1',
        bom: false,
        lineEnding: 'lf' as const,
      };
    }),
    fsSaveFile: vi.fn(async (_s: number, path: string) =>
      state.saveFails || real(path) === null
        ? { kind: 'failed' as const, message: 'no' }
        : { kind: 'saved' as const, revision: '2' },
    ),
  };
  return { client, state, members: () => members };
}

/** 뒤에서 도는 읽기(나열·열기 응답)가 끝날 때까지 기다린다 */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((done) => setTimeout(done, 0));
}

/** 그룹을 열고, 파일 탭을 고정으로 열어 편집 문서를 붙이고(초안을 쓸 수 있게), 트리를 펼친 상태를 만든다 */
async function openedGroup(session: number) {
  const core = groupCore(session);
  const store = createAppStore({ client: core.client, pickDirectory: async () => null });
  await store.getState().loadGroups();
  await store.getState().openGroupAt(ID);
  await settle();
  const ws = getWorkspaceStore(session);
  if (!ws) throw new Error('워크스페이스가 없다');
  const openFile = async (path: string, repoPath: string, draft: string | null) => {
    ws.getState().openDoc(
      fileViewDoc({ path, name: path.split('/').at(-1) ?? path, repoPath, repoName: null }),
      'pinned',
    );
    const doc = await fileEditors.open(core.client, session, path);
    if (!('state' in doc)) throw new Error('편집 문서가 아니다');
    if (draft !== null) {
      fileEditors.update(doc, doc.state.update({ changes: { from: 0, insert: draft } }).state);
    }
    return doc;
  };
  return { core, store, ws, openFile };
}

describe('열린 그룹 고치기 (M4)', () => {
  beforeEach(() => {
    writePref(PREF_EDITOR_TABS, {});
    writePref(recentFilesKey(KEY), []);
  });
  afterEach(async () => {
    // 편집 문서는 앱 전역이라 시험 사이에 같은 실제 파일의 문서를 나누지 않게 모두 놓는다
    await fileEditors.discard();
    for (const doc of fileEditors.documents()) {
      for (const source of [...doc.sources.values()]) fileEditors.release(source.session);
    }
    useFileCloseStore.setState({ pending: null });
  });

  it('뺀 멤버의 파일 탭에 초안이 있으면 확인을 묻고, 취소하면 아무것도 고치지 않는다 (원자적)', async () => {
    const { core, store, ws, openFile } = await openedGroup(7401);
    core.state.saveFails = true;
    const doc = await openFile('web/b.ts', '/x/web', 'draft ');
    const result = store
      .getState()
      .updateGroup(ID, { members: [{ alias: 'api', path: '/w/api' }] });
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    expect(useFileCloseStore.getState().pending?.paths).toEqual(['web/b.ts']);
    useFileCloseStore.getState().choose('cancel');
    expect(await result).toBe(false);
    expect(core.client.groupUpdate).not.toHaveBeenCalled();
    expect(ws.getState().docs.some((d) => d.id === fileViewDocId('web/b.ts'))).toBe(true);
    expect(doc.dirty).toBe(true);
    expect(core.members().map((x) => x.alias)).toEqual(['api', 'web']);
  });

  it('확인에서 초안을 버리면 그 탭만 닫고 연 채로 고친다 (다른 멤버의 고정 탭은 남는다)', async () => {
    const { core, store, ws, openFile } = await openedGroup(7402);
    core.state.saveFails = true;
    await openFile('api/src/a.ts', '/w/api', null);
    await openFile('web/b.ts', '/x/web', 'draft ');
    const result = store
      .getState()
      .updateGroup(ID, { members: [{ alias: 'api', path: '/w/api' }] });
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    useFileCloseStore.getState().choose('discard');
    expect(await result).toBe(true);
    expect(core.client.groupUpdate).toHaveBeenCalledTimes(1);
    expect(core.client.closeFolder).not.toHaveBeenCalled();
    const files = ws.getState().docs.flatMap((d) => (d.kind === 'file' ? [d.path] : []));
    expect(files).toEqual(['api/src/a.ts']);
    expect(fileEditors.get(7402, 'web/b.ts')).toBeUndefined();
    expect(store.getState().sessions[7402]?.path).toBe(KEY);
  });

  it('별칭을 바꾸면 초안·파일 탭·트리·저장한 기록이 새 별칭으로 옮겨지고 고치는 동안 문서는 멈춘다', async () => {
    writeSavedEditorTabs(KEY, {
      files: [{ path: 'api/src/a.ts', repoPath: '/w/api', repoName: 'api' }],
      active: 'api/src/a.ts',
    });
    writePref(recentFilesKey(KEY), ['api/src/a.ts', 'web/b.ts']);
    const { core, store, ws, openFile } = await openedGroup(7403);
    const doc = await openFile('api/src/a.ts', '/w/api', 'draft ');
    const tree = getFolderStore(7403)?.getState().fileTree;
    if (!tree) throw new Error('트리가 없다');
    tree.setState({
      expanded: { '': true, api: true, 'api/src': true },
      selected: 'api/src/a.ts',
      anchor: 'api/src/a.ts',
      selection: { 'api/src/a.ts': true },
    });
    const stampBefore = filesStamp(7403);

    expect(
      await store.getState().updateGroup(ID, {
        members: [
          { alias: 'backend', path: '/w/api' },
          { alias: 'web', path: '/x/web' },
        ],
      }),
    ).toBe(true);
    expect(core.state.lockedDuringUpdate).toEqual([true]);
    expect(doc.mutationLocked).toBe(false);
    // 같은 문서가 새 경로로 (다시 읽지 않아 초안이 그대로)
    expect(fileEditors.get(7403, 'backend/src/a.ts')).toBe(doc);
    expect(fileEditors.get(7403, 'api/src/a.ts')).toBeUndefined();
    expect(doc.dirty).toBe(true);
    expect(doc.state.doc.toString()).toBe('draft body\n');
    expect(ws.getState().activeDocId).toBe(fileViewDocId('backend/src/a.ts'));
    expect(ws.getState().docs.some((d) => d.id === fileViewDocId('api/src/a.ts'))).toBe(false);
    // 트리: 고치는 사이 다시 읽어 옛 별칭이 지워져도 고치기 전 상태를 옮겨 되살린다
    const t = tree.getState();
    expect(t.selected).toBe('backend/src/a.ts');
    expect(Object.keys(t.expanded).sort()).toEqual(['', 'backend', 'backend/src']);
    await settle();
    expect(tree.getState().dirs['backend/src']?.load.state).toBe('listed');
    // 저장한 기록
    expect(readSavedEditorTabs(KEY)).toEqual({
      files: [{ path: 'backend/src/a.ts', repoPath: '/w/api', repoName: 'api' }],
      active: 'backend/src/a.ts',
    });
    expect(readRecentFiles(KEY)).toEqual(['backend/src/a.ts', 'web/b.ts']);
    // ⌘P 목록은 표지가 바뀌어 다시 받는다
    expect(filesStamp(7403)).not.toEqual(stampBefore);
    // 초안은 새 경로로 저장된다
    expect(await fileEditors.flush(7403)).toBe(true);
    expect(core.client.fsSaveFile).toHaveBeenLastCalledWith(
      7403,
      'backend/src/a.ts',
      '1',
      'draft body\n',
    );
  });

  it('코어가 거부하면 알리고 멈춘 문서를 다시 움직이며 경로를 옮기지 않는다', async () => {
    const { core, store, ws, openFile } = await openedGroup(7404);
    const doc = await openFile('api/src/a.ts', '/w/api', 'draft ');
    vi.mocked(core.client.groupUpdate).mockRejectedValueOnce(new Error('nope'));
    expect(
      await store.getState().updateGroup(ID, {
        members: [
          { alias: 'backend', path: '/w/api' },
          { alias: 'web', path: '/x/web' },
        ],
      }),
    ).toBe(false);
    expect(doc.mutationLocked).toBe(false);
    expect(fileEditors.get(7404, 'api/src/a.ts')).toBe(doc);
    expect(ws.getState().activeDocId).toBe(fileViewDocId('api/src/a.ts'));
  });
});

describe('닫힌 그룹 고치기·지우기의 기록 정리 (M4)', () => {
  const OTHER = '/w/acme';
  beforeEach(() => {
    writePref(PREF_EDITOR_TABS, {});
    writeSavedEditorTabs(KEY, {
      files: [
        { path: 'api/a.ts', repoPath: '/w/api', repoName: 'api' },
        { path: 'web/b.ts', repoPath: '/x/web', repoName: 'web' },
      ],
      active: 'web/b.ts',
    });
    writeSavedEditorTabs(OTHER, {
      files: [{ path: 'api/a.ts', repoPath: null, repoName: null }],
      active: null,
    });
    for (const root of [KEY, OTHER]) {
      writePref(recentFilesKey(root), ['api/a.ts']);
      writePref(timelineRepoWidthKey(root), 240);
      writeFavoriteOverrides(root, { on: ['refs/heads/x'], off: [] });
      writePref(recentCommandsKey(root), ['git status']);
    }
  });

  it('닫힌 그룹의 별칭을 바꾸면 저장한 기록만 옮긴다', async () => {
    const core = groupCore(7405);
    const store = createAppStore({ client: core.client, pickDirectory: async () => null });
    await store.getState().loadGroups();
    expect(
      await store.getState().updateGroup(ID, {
        members: [
          { alias: 'backend', path: '/w/api' },
          { alias: 'web', path: '/x/web' },
        ],
      }),
    ).toBe(true);
    expect(readSavedEditorTabs(KEY)?.files.map((f) => f.path)).toEqual([
      'backend/a.ts',
      'web/b.ts',
    ]);
    expect(readRecentFiles(KEY)).toEqual(['backend/a.ts']);
    expect(readSavedEditorTabs(OTHER)?.files.map((f) => f.path)).toEqual(['api/a.ts']);
    expect(readRecentFiles(OTHER)).toEqual(['api/a.ts']);
  });

  it('그룹을 지우면 그 그룹 키의 탭 복원·최근 파일·열 너비·즐겨찾기·최근 명령을 지우고 다른 루트는 그대로다', async () => {
    const core = groupCore(7406);
    const store = createAppStore({ client: core.client, pickDirectory: async () => null });
    await store.getState().loadGroups();
    expect(await store.getState().deleteGroup(ID)).toBe(true);
    expect(core.client.groupDelete).toHaveBeenCalledWith(ID);
    expect(readSavedEditorTabs(KEY)).toBeNull();
    expect(readPref<unknown>(recentFilesKey(KEY), null)).toBeNull();
    expect(readPref<unknown>(timelineRepoWidthKey(KEY), null)).toBeNull();
    expect(readFavoriteOverrides(KEY)).toEqual({ on: [], off: [] });
    expect(readRecentCommands(KEY)).toEqual([]);
    expect(readSavedEditorTabs(OTHER)).not.toBeNull();
    expect(readRecentFiles(OTHER)).toEqual(['api/a.ts']);
    expect(readPref(timelineRepoWidthKey(OTHER), 0)).toBe(240);
    expect(readFavoriteOverrides(OTHER).on).toEqual(['refs/heads/x']);
    expect(readRecentCommands(OTHER)).toEqual(['git status']);
  });

  it('지우기를 코어가 거부하면 기록을 지우지 않는다', async () => {
    const core = groupCore(7407);
    vi.mocked(core.client.groupDelete).mockRejectedValueOnce(new Error('open'));
    const store = createAppStore({ client: core.client, pickDirectory: async () => null });
    expect(await store.getState().deleteGroup(ID)).toBe(false);
    expect(readSavedEditorTabs(KEY)).not.toBeNull();
    expect(readRecentFiles(KEY)).toEqual(['api/a.ts']);
  });

  it('forgetRootPrefs 는 없는 기록에도 조용하다', () => {
    expect(() => forgetRootPrefs('mgit-group:g0000000000ff')).not.toThrow();
  });
});
