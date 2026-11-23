import { createNullClient, emptyRepoState, GraphRangeCache, type IpcClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { docDetail, docTitle, docTooltip } from '../features/workspace/doc-labels';
import { createAppStore } from '../store/app-store';
import { clearSessionRegistry, getFolderStore, getWorkspaceStore } from '../store/session-registry';
import { createSessionStore, DEFAULT_DIFF_OPTIONS } from '../store/session-store';
import {
  activeRepoInList,
  type CommitDiffTarget,
  commitDiffDoc,
  commitDiffDocId,
  createWorkspaceStore,
  type DocRequest,
  docActivated,
  docClosed,
  docOpened,
  docPinned,
  docRepoPath,
  type EditorTabs,
  fileViewDoc,
  fileViewDocId,
  INITIAL_TAGS_VIEW,
  initialTabs,
  isSessionDoc,
  OVERVIEW_DOC,
  PREF_DIFF_OPTIONS,
  tagsDoc,
  tagsDocId,
} from '../store/workspace-store';

/** 문서 요청. 지금 문서 종류는 개요뿐이라 id 만 달리해 여러 문서를 만든다 */
const doc = (id: string): DocRequest => ({ id, kind: 'overview' });

const EMPTY: EditorTabs = { docs: [], activeDocId: null, recentDocIds: [] };

/** 탭 막대 모양: 고정 탭은 이름 그대로, 미리보기 탭은 `~이름`, 활성 탭은 `[ ]` */
function shape(tabs: EditorTabs): string {
  return tabs.docs
    .map((d) => {
      const name = d.pinned ? d.id : `~${d.id}`;
      return d.id === tabs.activeDocId ? `[${name}]` : name;
    })
    .join(' ');
}

describe('에디터 탭 전이 (ED-02)', () => {
  it('고정으로 열면 끝에 탭이 생기고 활성화된다', () => {
    const a = docOpened(EMPTY, doc('a'), 'pinned');
    const b = docOpened(a, doc('b'), 'pinned');
    expect(shape(a)).toBe('[a]');
    expect(shape(b)).toBe('a [b]');
    expect(b.recentDocIds).toEqual(['a', 'b']);
  });

  it('미리보기 탭은 하나뿐이다: 다음 미리보기가 열리면 그 자리에서 교체된다', () => {
    let tabs = docOpened(EMPTY, doc('a'), 'pinned');
    tabs = docOpened(tabs, doc('p1'), 'preview');
    tabs = docOpened(tabs, doc('b'), 'pinned');
    expect(shape(tabs)).toBe('a ~p1 [b]');
    tabs = docOpened(tabs, doc('p2'), 'preview');
    // p1 의 자리를 p2 가 차지하고, 사라진 p1 은 "본 순서"에서도 빠진다
    expect(shape(tabs)).toBe('a [~p2] b');
    expect(tabs.docs.filter((d) => !d.pinned)).toHaveLength(1);
    expect(tabs.recentDocIds).toEqual(['a', 'b', 'p2']);
  });

  it('미리보기 탭이 없으면 미리보기로 열어도 새 탭이 생긴다', () => {
    const tabs = docOpened(docOpened(EMPTY, doc('a'), 'pinned'), doc('p'), 'preview');
    expect(shape(tabs)).toBe('a [~p]');
  });

  it('이미 열린 문서를 다시 열면 탭을 늘리지 않고 그 탭을 활성화한다', () => {
    let tabs = docOpened(EMPTY, doc('a'), 'pinned');
    tabs = docOpened(tabs, doc('b'), 'pinned');
    tabs = docOpened(tabs, doc('a'), 'preview');
    // 고정 탭을 미리보기로 다시 열어도 고정은 풀리지 않는다
    expect(shape(tabs)).toBe('[a] b');
    expect(tabs.recentDocIds).toEqual(['b', 'a']);
  });

  it('미리보기 탭을 고정으로 다시 열거나 고정하면 고정 탭이 되고, 다음 미리보기는 새 탭으로 열린다', () => {
    let tabs = docOpened(EMPTY, doc('p'), 'preview');
    expect(shape(docOpened(tabs, doc('p'), 'pinned'))).toBe('[p]');
    tabs = docPinned(tabs, 'p');
    expect(shape(tabs)).toBe('[p]');
    expect(shape(docOpened(tabs, doc('q'), 'preview'))).toBe('p [~q]');
    // 이미 고정이거나 없는 문서면 그대로다 (같은 객체)
    expect(docPinned(tabs, 'p')).toBe(tabs);
    expect(docPinned(tabs, 'none')).toBe(tabs);
  });

  it('보던 문서를 닫으면 직전에 보던 문서로 돌아간다 (옆 탭이 아니다)', () => {
    let tabs = docOpened(EMPTY, doc('a'), 'pinned');
    tabs = docOpened(tabs, doc('b'), 'pinned');
    tabs = docOpened(tabs, doc('c'), 'pinned');
    tabs = docActivated(tabs, 'a');
    tabs = docActivated(tabs, 'c');
    expect(shape(tabs)).toBe('a b [c]');
    tabs = docClosed(tabs, 'c');
    expect(shape(tabs)).toBe('[a] b');
    tabs = docClosed(tabs, 'a');
    expect(shape(tabs)).toBe('[b]');
    tabs = docClosed(tabs, 'b');
    expect(tabs).toEqual(EMPTY);
  });

  it('보고 있지 않은 문서를 닫으면 활성 문서는 그대로다', () => {
    let tabs = docOpened(EMPTY, doc('a'), 'pinned');
    tabs = docOpened(tabs, doc('b'), 'pinned');
    tabs = docClosed(tabs, 'a');
    expect(shape(tabs)).toBe('[b]');
    expect(tabs.recentDocIds).toEqual(['b']);
  });

  it('없는 문서를 활성화하거나 닫으면 아무 일도 없다', () => {
    const tabs = docOpened(EMPTY, doc('a'), 'pinned');
    expect(docActivated(tabs, 'none')).toBe(tabs);
    expect(docClosed(tabs, 'none')).toBe(tabs);
  });
});

describe('워크스페이스 스토어', () => {
  it('폴더 워크스페이스는 개요가 고정 탭으로 열린 채 만들어진다 (ED-07)', () => {
    expect(shape(initialTabs('folder'))).toBe(`[${OVERVIEW_DOC.id}]`);
    const store = createWorkspaceStore('folder');
    expect(store.getState().rootKind).toBe('folder');
    expect(store.getState().docs).toEqual([{ ...OVERVIEW_DOC, pinned: true }]);
    expect(store.getState().activeDocId).toBe(OVERVIEW_DOC.id);
    expect(store.getState().activeRepo).toBeNull();
  });

  it('저장소 워크스페이스는 문서 없이 만들어진다', () => {
    expect(initialTabs('repo')).toEqual(EMPTY);
    expect(createWorkspaceStore('repo').getState().docs).toEqual([]);
  });

  it('개요를 닫으면 비고, 다시 열면 개요 탭이 돌아온다', () => {
    const store = createWorkspaceStore('folder');
    store.getState().closeDoc(OVERVIEW_DOC.id);
    expect(store.getState().docs).toEqual([]);
    expect(store.getState().activeDocId).toBeNull();
    store.getState().openDoc(OVERVIEW_DOC, 'pinned');
    expect(shape(store.getState())).toBe(`[${OVERVIEW_DOC.id}]`);
  });

  it('액션은 전이 함수 그대로 움직이고, 문서를 열 때만 알린다', () => {
    const onDocOpened = vi.fn();
    const store = createWorkspaceStore('folder', { onDocOpened });
    // 만들 때 열려 있는 개요는 "열림" 알림이 아니다
    expect(onDocOpened).not.toHaveBeenCalled();
    store.getState().openDoc(doc('p'), 'preview');
    expect(shape(store.getState())).toBe('overview [~p]');
    expect(onDocOpened).toHaveBeenCalledTimes(1);
    store.getState().pinDoc('p');
    store.getState().activateDoc(OVERVIEW_DOC.id);
    expect(shape(store.getState())).toBe('[overview] p');
    store.getState().closeDoc(OVERVIEW_DOC.id);
    expect(shape(store.getState())).toBe('[p]');
    expect(onDocOpened).toHaveBeenCalledTimes(1);
    // 이미 열린 문서를 다시 여는 것도 "문서 열기"다
    store.getState().openDoc(doc('p'), 'preview');
    expect(onDocOpened).toHaveBeenCalledTimes(2);
  });

  // W3 의 "프로젝트 트리의 선택을 둔다"(`selectProject`)는 W11 에서 선택이 파일 트리 스토어로 옮겨 가며
  // (`file-tree.test.ts`) 활성 저장소 규칙으로 바뀌었다 (WS-07)
  it('활성 저장소: 트리에서 정하면 바뀌고, 저장소 밖(null)이면 그대로다', () => {
    const store = createWorkspaceStore('folder');
    store.getState().setActiveRepo('/w/api');
    expect(store.getState().activeRepo).toBe('/w/api');
    store.getState().setActiveRepo(null);
    expect(store.getState().activeRepo).toBe('/w/api');
  });

  it('재스캔으로 저장소 목록에서 빠진 활성 저장소는 비우고, 목록을 아직 못 읽었으면 그대로 둔다', () => {
    expect(activeRepoInList('/w/api', ['/w/api', '/w/web'])).toBe('/w/api');
    expect(activeRepoInList('/w/api', ['/w/api-v2', '/w/web'])).toBeNull();
    expect(activeRepoInList('/w/api', [])).toBeNull();
    expect(activeRepoInList('/w/api', null)).toBe('/w/api');
    expect(activeRepoInList(null, ['/w/web'])).toBeNull();

    const store = createWorkspaceStore('folder');
    store.getState().setActiveRepo('/w/api');
    store.getState().retainActiveRepo(null);
    expect(store.getState().activeRepo).toBe('/w/api');
    const before = store.getState();
    store.getState().retainActiveRepo(['/w/api']);
    // 그대로면 상태를 바꾸지 않는다
    expect(store.getState()).toBe(before);
    store.getState().retainActiveRepo(['/w/web']);
    expect(store.getState().activeRepo).toBeNull();
  });
});

describe('활성 저장소와 에디터 탭 (WS-07)', () => {
  /** 파일 보기 문서 */
  const fileDoc = (path: string, repo: string | null) =>
    fileViewDoc({
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      repoPath: repo === null ? null : `/w/${repo}`,
      repoName: repo,
    });

  it('문서를 열거나 활성화하면 그 문서의 저장소가 되고, 저장소 없는 문서는 그대로 둔다', () => {
    const store = createWorkspaceStore('folder');
    const api = fileDoc('api/src/a.ts', 'api');
    const web = fileDoc('web/index.ts', 'web');
    store.getState().openDoc(api, 'pinned');
    expect(store.getState().activeRepo).toBe('/w/api');
    store.getState().openDoc(web, 'pinned');
    expect(store.getState().activeRepo).toBe('/w/web');
    store.getState().activateDoc(api.id);
    expect(store.getState().activeRepo).toBe('/w/api');
    // 개요·저장소 밖 파일은 바꾸지 않는다
    store.getState().activateDoc(OVERVIEW_DOC.id);
    expect(store.getState().activeRepo).toBe('/w/api');
    store.getState().openDoc(fileDoc('README.md', null), 'preview');
    expect(store.getState().activeRepo).toBe('/w/api');
    // 커밋 diff 문서도 그 저장소다
    store.getState().openDoc(
      commitDiffDoc({
        repoPath: '/w/web',
        repoName: 'web',
        oid: 'a'.repeat(40),
        path: 'x',
        oldPath: null,
        merge: false,
      }),
      'preview',
    );
    expect(store.getState().activeRepo).toBe('/w/web');
  });

  it('보던 탭을 닫으면 활성화된 문서를 따르고, 뒤의 탭을 닫으면 그대로다', () => {
    const store = createWorkspaceStore('folder');
    const api = fileDoc('api/a.ts', 'api');
    const web = fileDoc('web/b.ts', 'web');
    store.getState().openDoc(api, 'pinned');
    store.getState().openDoc(web, 'pinned');
    // 트리에서 다른 저장소를 골랐다
    store.getState().setActiveRepo('/w/other');
    store.getState().closeDoc(api.id);
    expect(store.getState().activeRepo).toBe('/w/other');
    store.getState().closeDoc(web.id);
    // 개요가 활성화된다: 저장소가 없으니 그대로
    expect(store.getState().activeDocId).toBe(OVERVIEW_DOC.id);
    expect(store.getState().activeRepo).toBe('/w/other');
  });

  it('문서별 스크롤 위치를 기억하고, 닫힌 문서의 것은 버린다', () => {
    const store = createWorkspaceStore('folder');
    const a = fileDoc('a.ts', null);
    store.getState().openDoc(a, 'pinned');
    store.getState().rememberDocScroll(a.id, 420);
    store.getState().activateDoc(OVERVIEW_DOC.id);
    expect(store.getState().docScrollTop(a.id)).toBe(420);
    store.getState().closeDoc(a.id);
    expect(store.getState().docScrollTop(a.id)).toBe(0);
  });
});

describe('파일 보기 문서 (ED-04)', () => {
  it('id 는 루트 기준 상대 경로로 정해지고, 미리보기는 같은 탭을 교체한다', () => {
    const a = fileViewDoc({ path: 'api/a.ts', name: 'a.ts', repoPath: '/w/api', repoName: 'api' });
    expect(a.id).toBe(fileViewDocId('api/a.ts'));
    expect(fileViewDoc({ path: 'api/a.ts', name: 'x', repoPath: null, repoName: null }).id).toBe(
      a.id,
    );
    const store = createWorkspaceStore('folder');
    store.getState().openDoc(a, 'preview');
    store
      .getState()
      .openDoc(
        fileViewDoc({ path: 'api/b.ts', name: 'b.ts', repoPath: '/w/api', repoName: 'api' }),
        'preview',
      );
    expect(shape(store.getState())).toBe('overview [~file:api/b.ts]');
  });

  it('탭 제목은 파일 이름, 보조 글자는 저장소 이름(밖이면 상위 폴더), 툴팁은 전체 상대 경로', () => {
    const inRepo = fileViewDoc({
      path: 'api/src/Main.java',
      name: 'Main.java',
      repoPath: '/w/api',
      repoName: 'api',
    });
    expect(docTitle(inRepo)).toBe('Main.java');
    expect(docDetail(inRepo)).toBe('api');
    expect(docTooltip(inRepo)).toBe('api/src/Main.java');
    const outside = fileViewDoc({
      path: 'docs/guide/setup.md',
      name: 'setup.md',
      repoPath: null,
      repoName: null,
    });
    expect(docDetail(outside)).toBe('guide');
    expect(
      docDetail(
        fileViewDoc({ path: 'README.md', name: 'README.md', repoPath: null, repoName: null }),
      ),
    ).toBeUndefined();
  });
});

describe('커밋 파일 diff 문서 (ED-02·03)', () => {
  const OID = 'a1b2c3d4'.padEnd(40, 'e');
  /** 커밋 diff 문서 요청 */
  const diffDoc = (repo: string, path: string, partial: Partial<CommitDiffTarget> = {}) =>
    commitDiffDoc({
      repoPath: `/w/${repo}`,
      repoName: repo,
      oid: OID,
      path,
      oldPath: null,
      merge: false,
      ...partial,
    });

  it('id 는 (저장소, 커밋, 경로)로 정해진다: 표시용 값이 달라도 같은 파일이면 같은 id 다', () => {
    expect(diffDoc('api', 'src/a.ts').id).toBe(commitDiffDocId('/w/api', OID, 'src/a.ts'));
    expect(diffDoc('api', 'src/a.ts', { repoName: '다른 이름', merge: true }).id).toBe(
      diffDoc('api', 'src/a.ts').id,
    );
    const ids = new Set([
      diffDoc('api', 'src/a.ts').id,
      diffDoc('web', 'src/a.ts').id,
      diffDoc('api', 'src/b.ts').id,
      diffDoc('api', 'src/a.ts', { oid: 'f'.repeat(40) }).id,
      // 구분자를 품은 경로도 섞이지 않는다
      commitDiffDocId('/w/a', OID, 'b'),
      commitDiffDocId('/w/a"', OID, 'b'),
    ]);
    expect(ids.size).toBe(6);
  });

  it('미리보기는 기존 미리보기 탭을 교체하고, 고정은 남으며, 같은 파일을 다시 열면 그 탭이 활성화된다', () => {
    const store = createWorkspaceStore('folder');
    const a = diffDoc('api', 'src/a.ts');
    const b = diffDoc('api', 'src/b.ts');
    const c = diffDoc('web', 'src/a.ts');
    store.getState().openDoc(a, 'preview');
    store.getState().openDoc(b, 'preview');
    // a 의 자리를 b 가 차지한다
    expect(store.getState().docs.map((d) => [d.id, d.pinned])).toEqual([
      [OVERVIEW_DOC.id, true],
      [b.id, false],
    ]);
    store.getState().openDoc(b, 'pinned');
    store.getState().openDoc(c, 'preview');
    expect(store.getState().docs.map((d) => [d.id, d.pinned])).toEqual([
      [OVERVIEW_DOC.id, true],
      [b.id, true],
      [c.id, false],
    ]);
    store.getState().activateDoc(OVERVIEW_DOC.id);
    store.getState().openDoc(b, 'preview');
    expect(store.getState().activeDocId).toBe(b.id);
    expect(store.getState().docs).toHaveLength(3);
    // 탭을 닫으면 직전에 보던 문서로 돌아간다
    store.getState().closeDoc(b.id);
    expect(store.getState().activeDocId).toBe(OVERVIEW_DOC.id);
  });

  it('탭 제목은 `파일이름 @해시8`, 보조 글자는 저장소 이름, 툴팁은 `저장소: 경로 @해시8`', () => {
    const d = diffDoc('api', 'src/routes/orders.ts');
    expect(docTitle(d)).toBe('orders.ts @a1b2c3d4');
    expect(docDetail(d)).toBe('api');
    expect(docTooltip(d)).toBe('api: src/routes/orders.ts @a1b2c3d4');
    expect(docTitle(diffDoc('api', 'README.md'))).toBe('README.md @a1b2c3d4');
    expect(docTitle(OVERVIEW_DOC)).toBe(S.workspace.overview);
    expect(docDetail(OVERVIEW_DOC)).toBeUndefined();
    expect(docTooltip(OVERVIEW_DOC)).toBeUndefined();
  });

  it('diff 보기 옵션은 저장소 탭과 같은 설정 키를 읽고 쓴다', () => {
    localStorage.clear();
    const store = createWorkspaceStore('folder');
    expect(store.getState().diffOptions).toEqual(DEFAULT_DIFF_OPTIONS);
    expect(store.getState().diffMode).toBe('unified');
    store.getState().setDiffOptions({ ignoreWhitespace: true, context: 7 });
    store.getState().setDiffMode('split');
    expect(store.getState().diffMode).toBe('split');
    expect(JSON.parse(localStorage.getItem(PREF_DIFF_OPTIONS) ?? 'null')).toMatchObject({
      ignoreWhitespace: true,
      context: 7,
    });
    // 새로 만든 워크스페이스와 저장소 탭의 세션 스토어가 같은 값을 읽는다
    expect(createWorkspaceStore('folder').getState().diffOptions.context).toBe(7);
    const head = { state: 'unborn' as const, branch: 'main' };
    const session = createSessionStore(
      {
        session: 99,
        alreadyOpen: false,
        nestedRepos: [],
        superproject: null,
        info: {
          workTree: '/w/api',
          gitDir: '/w/api/.git',
          commonDir: '/w/api/.git',
          objectFormat: 'sha1',
          head,
          commitGraph: { present: false },
          shallow: false,
        },
        state: emptyRepoState(head),
      },
      createNullClient(),
      new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('no session')) }),
    );
    expect(session.getState().diffOptions).toMatchObject({ ignoreWhitespace: true, context: 7 });
    localStorage.clear();
  });
});

describe('앱 탭과 워크스페이스 (WS-03)', () => {
  /** 폴더를 세션 7 로 여는 가짜 클라이언트 */
  function fakeClient(): IpcClient {
    return {
      ...createNullClient(),
      openFolder: vi.fn(async (path: string) => ({ session: 7, path, repos: [] })),
      closeFolder: vi.fn(async () => {}),
    };
  }

  beforeEach(() => {
    clearSessionRegistry();
    localStorage.clear();
  });

  it('폴더 탭을 열면 그 탭의 워크스페이스가 생기고, 닫으면 버린다', async () => {
    const store = createAppStore({ client: fakeClient(), pickDirectory: async () => null });
    expect(getWorkspaceStore(7)).toBeUndefined();
    await store.getState().openFolderAt('/w');
    expect(store.getState().sessions[7]?.kind).toBe('folder');
    const workspace = getWorkspaceStore(7);
    expect(workspace?.getState().rootKind).toBe('folder');
    expect(workspace?.getState().activeDocId).toBe(OVERVIEW_DOC.id);

    await store.getState().closeSession(7);
    expect(getWorkspaceStore(7)).toBeUndefined();
    expect(getFolderStore(7)).toBeUndefined();
  });

  it('같은 폴더를 다시 열어도 워크스페이스 상태를 새로 만들지 않는다', async () => {
    const store = createAppStore({ client: fakeClient(), pickDirectory: async () => null });
    await store.getState().openFolderAt('/w');
    const workspace = getWorkspaceStore(7);
    workspace?.getState().closeDoc(OVERVIEW_DOC.id);
    await store.getState().openFolderAt('/w');
    expect(getWorkspaceStore(7)).toBe(workspace);
    expect(workspace?.getState().docs).toEqual([]);
  });

  it('문서를 열면 본문을 덮고 있던 아래 도구 창의 최대화가 풀린다', async () => {
    const store = createAppStore({ client: fakeClient(), pickDirectory: async () => null });
    await store.getState().openFolderAt('/w');
    store.getState().setDockMaximized(true);
    expect(store.getState().dock).toMatchObject({ tool: 'git', maximized: true });

    getWorkspaceStore(7)?.getState().openDoc(OVERVIEW_DOC, 'pinned');
    // 최대화만 풀리고 도구 창은 그대로 보인다
    expect(store.getState().dock).toMatchObject({ tool: 'git', maximized: false });
  });
});

describe('Commit 도구 창의 저장소 보이기 요청 (W19)', () => {
  it('요청마다 차례가 오르고, 그 차례를 알리면 비며, 그 뒤에 온 새 요청은 옛 차례의 알림으로 지워지지 않는다', () => {
    const ws = createWorkspaceStore('folder');
    expect(ws.getState().commitReveal).toBeNull();
    ws.getState().revealCommitRepo('/f/a');
    const first = ws.getState().commitReveal;
    expect(first?.repoPath).toBe('/f/a');
    ws.getState().revealCommitRepo('/f/b');
    const second = ws.getState().commitReveal;
    expect(second).toMatchObject({ repoPath: '/f/b' });
    expect(second?.seq).toBeGreaterThan(first?.seq ?? 0);
    ws.getState().ackCommitReveal(first?.seq ?? -1);
    expect(ws.getState().commitReveal).toEqual(second);
    ws.getState().ackCommitReveal(second?.seq ?? -1);
    expect(ws.getState().commitReveal).toBeNull();
  });
});

describe('W21 에서 더한 것·고친 것', () => {
  it('미리보기 탭을 바꿔도 세션 문서(diff·충돌 탭)는 탭 막대에 남는다 (고친 결함: 교체 경로가 세션 문서를 빠뜨렸다)', () => {
    const diff = { ...doc('worktreeDiff:/r'), pinned: true };
    const tabs: EditorTabs = { ...EMPTY, sessionDocs: [diff] };
    const one = docOpened(tabs, doc('p1'), 'preview');
    const two = docOpened(one, doc('p2'), 'preview');
    expect(two.sessionDocs).toEqual([diff]);
    expect(shape(two)).toBe('[~p2]');
    // 스토어로도 같다: 세션 문서가 있는 채 미리보기를 두 번 연다
    const ws = createWorkspaceStore('repo');
    ws.getState().setSessionDocs([{ id: 'worktreeDiff:/r', kind: 'overview' }]);
    ws.getState().openDoc(doc('p1'), 'preview');
    ws.getState().openDoc(doc('p2'), 'preview');
    expect(ws.getState().sessionDocs.map((d) => d.id)).toEqual(['worktreeDiff:/r']);
  });

  it('저장소 탭 로그의 스크롤 기준을 기억한다 (구독 상태 밖, 탭마다 따로)', () => {
    const a = createWorkspaceStore('repo');
    const b = createWorkspaceStore('repo');
    const seen = vi.fn();
    a.subscribe(seen);
    expect(a.getState().logAnchor()).toBeNull();
    a.getState().rememberLogAnchor({ oid: 'x'.repeat(40), repo: null, row: 91, offset: 6 });
    expect(a.getState().logAnchor()).toEqual({
      oid: 'x'.repeat(40),
      repo: null,
      row: 91,
      offset: 6,
    });
    expect(b.getState().logAnchor()).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });

  it('저장소 탭에서 충돌을 읽는 동안(경로가 빈 충돌 문서)의 탭 제목·툴팁은 "여는 중" 이다', () => {
    const opening = {
      kind: 'conflict' as const,
      repoPath: '/w/api',
      repoName: 'api',
      path: '',
      draft: false,
    };
    expect(docTitle(opening)).toBe(S.workspace.conflictOpening);
    expect(docTooltip(opening)).toBe(S.workspace.conflictOpeningTip('api'));
    expect(docDetail(opening)).toBe('api');
    const opened = { ...opening, path: 'src/a.ts', draft: true };
    expect(docTitle(opened)).toBe(S.workspace.conflictTitle('a.ts', true));
  });
});

describe('태그 문서 (C3a, TG-10)', () => {
  it('저장소당 하나(id = 저장소)이고 저장소 문서다. 세션 문서가 아니다. 탭 글자는 "태그"와 저장소 이름', () => {
    const doc = tagsDoc({ repoPath: '/r/web', repoName: 'web' });
    expect(doc).toEqual({
      kind: 'tags',
      repoPath: '/r/web',
      repoName: 'web',
      id: tagsDocId('/r/web'),
    });
    expect(tagsDocId('/r/web')).not.toBe(tagsDocId('/r/api'));
    expect(docRepoPath(doc)).toBe('/r/web');
    expect(isSessionDoc(doc)).toBe(false);
    expect(docTitle(doc)).toBe(S.tag.doc.title);
    expect(docDetail(doc)).toBe('web');
    expect(docTooltip(doc)).toBeUndefined();
  });

  it('고정 탭으로 열리고 다시 열면 같은 탭이다. 화면 상태는 탭의 워크스페이스에 일부씩 바뀐다', () => {
    const ws = createWorkspaceStore('repo');
    const doc = tagsDoc({ repoPath: '/r/web', repoName: 'web' });
    ws.getState().openDoc(doc, 'pinned');
    ws.getState().openDoc(doc, 'pinned');
    expect(ws.getState().docs.filter((d) => d.kind === 'tags')).toEqual([{ ...doc, pinned: true }]);
    expect(ws.getState().activeDocId).toBe(doc.id);
    expect(ws.getState().tagsView).toEqual(INITIAL_TAGS_VIEW);
    ws.getState().setTagsView({ filter: 'localOnly', selected: ['v1'] });
    expect(ws.getState().tagsView).toEqual({
      ...INITIAL_TAGS_VIEW,
      filter: 'localOnly',
      selected: ['v1'],
    });
  });
});
