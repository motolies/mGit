import { formatShortcut, matchShortcut, S } from '@mgit/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActionContext, buildActions, focusPanel } from '../actions';
import type { DockState, TabKind } from '../store/app-store';

/** 최소 컨텍스트. 탭 종류를 주지 않으면 세션이 있을 때 저장소 탭, 없으면 탭 없음이다 */
function ctx(
  partial: {
    active?: number | null;
    session?: Partial<ActionContext['session']>;
    tabKind?: TabKind | null;
    dock?: Partial<DockState>;
    overrides?: Record<string, string | null>;
  } = {},
): ActionContext {
  const app = {
    activeSessionId: partial.active ?? null,
    sessionOrder:
      partial.active === undefined || partial.active === null ? [] : [1, partial.active],
    isOpening: false,
    theme: 'system',
    shortcutOverrides: partial.overrides ?? {},
    dock: { tool: null, maximized: false, gitTab: 'console', ...partial.dock },
    setLeftTool: vi.fn(),
    openRepository: vi.fn(async () => {}),
    requestCloseSession: vi.fn(async () => {}),
    setActiveSession: vi.fn(),
    refreshActive: vi.fn(async () => {}),
    toggleDock: vi.fn(),
    hideDock: vi.fn(),
    toggleDockMaximized: vi.fn(),
    setDockMaximized: vi.fn(),
    openExternal: vi.fn(async () => {}),
    setSettingsOpen: vi.fn(),
    setTheme: vi.fn(),
  } as unknown as ActionContext['app'];
  const session =
    partial.session === undefined
      ? null
      : ({
          busy: false,
          op: null,
          path: '/r',
          refs: {
            remotes: [{ name: 'origin' }],
            labels: [{ isCurrent: true, upstream: 'origin/main' }],
          },
          status: { summary: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } },
          undoState: { entries: [], redoCount: 0 },
          fetch: vi.fn(async () => {}),
          pull: vi.fn(async () => {}),
          push: vi.fn(async () => {}),
          setSearchOpen: vi.fn(),
          stashPush: vi.fn(async () => {}),
          ...partial.session,
        } as unknown as ActionContext['session']);
  return {
    app,
    session,
    tabKind: partial.tabKind === undefined ? (session === null ? null : 'repo') : partial.tabKind,
    openQuickSwitch: vi.fn(),
    startClone: vi.fn(),
    startInit: vi.fn(),
    promptBranch: vi.fn(),
    promptCompare: vi.fn(),
    promptColumns: vi.fn(),
  };
}

describe('actions', () => {
  it('저장소가 없으면 저장소 동작은 꺼지고 앱 동작은 켜진다', () => {
    const list = buildActions(ctx());
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(byId['sync.fetch']?.enabled).toBe(false);
    expect(byId['view.search']?.enabled).toBe(false);
    expect(byId['repo.open']?.enabled).toBe(true);
    expect(byId['app.settings']?.enabled).toBe(true);
    expect(new Set(list.map((a) => a.id)).size).toBe(list.length);
  });

  it('저장소가 있으면 동기화·외부 앱 동작이 켜지고 실행된다', () => {
    const c = ctx({ active: 2, session: {} });
    const byId = Object.fromEntries(buildActions(c).map((a) => [a.id, a]));
    expect(byId['sync.push']?.enabled).toBe(true);
    expect(byId['branch.stash']?.enabled).toBe(true);
    byId['sync.fetch']?.run();
    expect(c.session?.fetch).toHaveBeenCalledWith(null, true);
    byId['external.editor']?.run();
    expect(c.app.openExternal).toHaveBeenCalledWith('editor', '/r');
    byId['repo.nextTab']?.run();
    expect(c.app.setActiveSession).toHaveBeenCalledWith(1);
  });

  it('진행 중 작업이 있으면 병합류·동기화가 꺼진다', () => {
    const byId = Object.fromEntries(
      buildActions(ctx({ active: 2, session: { op: { kind: 'merge', head: 'x' } } })).map((a) => [
        a.id,
        a,
      ]),
    );
    expect(byId['sync.pull']?.enabled).toBe(false);
    expect(byId['view.refresh']?.enabled).toBe(true);
  });
});

/** W2 이전부터 있던 동작 id (팔레트 순서). 사용자 재지정 단축키가 이 id 로 저장돼 있다 (UX-04, WS-20) */
const LEGACY_IDS = [
  'repo.open',
  'repo.clone',
  'repo.init',
  'repo.close',
  'repo.nextTab',
  'repo.prevTab',
  'view.refresh',
  'sync.fetch',
  'sync.pull',
  'sync.push',
  'view.search',
  'view.terminal',
  'view.graphFilter',
  'view.columns',
  'view.compare',
  'view.focusSidebar',
  'view.focusGraph',
  'view.focusDetail',
  'repo.settings',
  'repo.browseRemote',
  'app.accounts',
  'app.profiles',
  'app.sshKeys',
  'app.shortcuts',
  'branch.quickSwitch',
  'branch.create',
  'branch.stash',
  'view.log',
  'external.editor',
  'external.terminal',
  'external.reveal',
  'app.settings',
  'app.themeLight',
  'app.themeDark',
  'app.themeSystem',
  'edit.undo',
  'edit.redo',
  'safety.reflog',
  'safety.fileBackups',
];

describe('아래 도구 창 동작 (WS-03)', () => {
  /** id → 동작 */
  const byId = (c: ActionContext) => Object.fromEntries(buildActions(c).map((a) => [a.id, a]));

  it('기존 동작 id 와 순서는 그대로이고 새 동작은 목록 끝에 붙는다', () => {
    const ids = buildActions(ctx()).map((a) => a.id);
    expect(ids.slice(0, LEGACY_IDS.length)).toEqual(LEGACY_IDS);
    expect(ids.slice(LEGACY_IDS.length)).toEqual([
      'view.dockMaximize',
      'view.dockHide',
      'view.focusEditor',
      'view.toolCommit',
      'view.toolPullRequests',
      'sync.checkRemoteTags',
      'view.tagsDoc',
      'sync.pushAllTags',
    ]);
  });

  it('원격 tag 확인(B5): 기본 키가 없고 원격이 있는 저장소 탭에서 켜진다. 실행 중(busy)이어도 켜진다 (D15)', () => {
    const checkRemoteTags = vi.fn(async () => {});
    expect(byId(ctx())['sync.checkRemoteTags']?.enabled).toBe(false);
    expect(
      byId(ctx({ active: 2, session: { refs: { remotes: [], labels: [] } } as never }))[
        'sync.checkRemoteTags'
      ]?.enabled,
    ).toBe(false);
    const busy = byId(ctx({ active: 2, session: { busy: true, checkRemoteTags } as never }));
    expect(busy['sync.checkRemoteTags']?.enabled).toBe(true);
    expect(busy['sync.checkRemoteTags']?.shortcut).toBeUndefined();
    expect(busy['sync.checkRemoteTags']?.title).toBe(S.actions.checkRemoteTags);
    busy['sync.checkRemoteTags']?.run();
    expect(checkRemoteTags).toHaveBeenCalledWith();
  });

  it('tag 관리(C3a): 기본 키가 없고, 연 쪽이 문서 열기를 준 저장소 탭에서만 켜진다. 실행하면 최대화를 풀고 연다', () => {
    const openTagsDoc = vi.fn();
    expect(byId(ctx({ active: 2, session: {} }))['view.tagsDoc']?.enabled).toBe(false);
    const c = { ...ctx({ active: 2, session: {} }), openTagsDoc };
    const action = byId(c)['view.tagsDoc'];
    expect(action?.enabled).toBe(true);
    expect(action?.shortcut).toBeUndefined();
    expect(action?.title).toBe(S.actions.tagsDoc);
    action?.run();
    expect(c.app.setDockMaximized).toHaveBeenCalledWith(false);
    expect(openTagsDoc).toHaveBeenCalledTimes(1);
  });

  it('모든 tag push…(C4, TG-13): 원격이 있고 문서를 열 수 있는 저장소 탭에서 켜지고, 기본 원격으로 요청해 연다', () => {
    const openTagsDoc = vi.fn();
    const c = { ...ctx({ active: 2, session: {} }), openTagsDoc };
    const action = byId(c)['sync.pushAllTags'];
    expect(action?.enabled).toBe(true);
    expect(action?.shortcut).toBeUndefined();
    action?.run();
    expect(openTagsDoc).toHaveBeenCalledWith({ kind: 'pushAll', remote: null });
    const none = {
      ...ctx({ active: 2, session: { refs: { remotes: [], labels: [] } } as never }),
      openTagsDoc,
    };
    expect(byId(none)['sync.pushAllTags']?.enabled).toBe(false);
  });

  it('Pull Requests 도구 창(W24): 기본 키가 없고, 원격 프로젝트가 있는 저장소 탭에서만 켜진다. 열면 왼쪽 자리에 PR 을 열고 최대화를 푼다', () => {
    const github = {
      accountId: 'github:github.com:kim',
      kind: 'github',
      host: 'github.com',
      project: 'kim/app',
      remote: 'origin',
    };
    // 탭 없음·폴더 탭·원격 프로젝트 없는 저장소 탭에서는 꺼진다
    expect(byId(ctx())['view.toolPullRequests']?.enabled).toBe(false);
    expect(byId(ctx({ active: 2, tabKind: 'folder' }))['view.toolPullRequests']?.enabled).toBe(
      false,
    );
    expect(
      byId(ctx({ active: 2, session: { remoteProject: null } }))['view.toolPullRequests']?.enabled,
    ).toBe(false);
    const r = ctx({
      active: 2,
      session: { remoteProject: github } as never,
      dock: { tool: 'git', maximized: true },
    });
    const repoTab = byId(r)['view.toolPullRequests'];
    expect(repoTab?.shortcut).toBeUndefined();
    expect(repoTab?.enabled).toBe(true);
    expect(repoTab?.title).toBe(S.actions.toolPullRequests(S.pr.title('github')));
    repoTab?.run();
    expect(r.app.setLeftTool).toHaveBeenCalledWith('pullRequests');
    expect(r.app.setDockMaximized).toHaveBeenCalledWith(false);
    // 계정이 없어도 원격 프로젝트가 있으면 켜진다 (도구 창 안에서 계정 연결을 안내한다). GitLab 이면 제목이 Merge Requests
    const gitlab = byId(
      ctx({
        active: 2,
        session: { remoteProject: { ...github, kind: 'gitlab', accountId: null } } as never,
      }),
    )['view.toolPullRequests'];
    expect(gitlab?.enabled).toBe(true);
    expect(gitlab?.title).toBe(S.actions.toolPullRequests('Merge Requests'));
    // 사용자 재지정 키가 적용된다 (WS-20)
    expect(
      byId(
        ctx({
          active: 2,
          session: { remoteProject: github } as never,
          overrides: { 'view.toolPullRequests': 'f8' },
        }),
      )['view.toolPullRequests']?.shortcut,
    ).toBe('f8');
  });

  it('⌘0 은 Commit 도구 창을 왼쪽 자리에 열고 최대화를 푼다. 폴더 탭(W14)·저장소 탭(W21)에서 켜지고 탭이 없으면 꺼진다', () => {
    expect(byId(ctx())['view.toolCommit']?.enabled).toBe(false);
    const r = ctx({ active: 2, session: {}, dock: { tool: 'git', maximized: true } });
    const repoTab = byId(r);
    expect(repoTab['view.toolCommit']?.shortcut).toBe('mod+0');
    expect(repoTab['view.toolCommit']?.enabled).toBe(true);
    repoTab['view.toolCommit']?.run();
    expect(r.app.setLeftTool).toHaveBeenCalledWith('commit');
    expect(r.app.setDockMaximized).toHaveBeenCalledWith(false);
    const c = ctx({ active: 2, tabKind: 'folder', dock: { tool: 'git', maximized: true } });
    const folder = byId(c);
    expect(folder['view.toolCommit']?.enabled).toBe(true);
    folder['view.toolCommit']?.run();
    expect(c.app.setLeftTool).toHaveBeenCalledWith('commit');
    expect(c.app.setDockMaximized).toHaveBeenCalledWith(false);
  });

  it('⌘J·⌘⇧J 는 단축키가 그대로이고 도구 창 토글을 부른다', () => {
    const c = ctx();
    const actions = byId(c);
    expect(actions['view.log']?.shortcut).toBe('mod+j');
    expect(actions['view.terminal']?.shortcut).toBe('mod+shift+j');
    actions['view.log']?.run();
    expect(c.app.toggleDock).toHaveBeenLastCalledWith('git', 'console');
    actions['view.terminal']?.run();
    expect(c.app.toggleDock).toHaveBeenLastCalledWith('terminal');
    // 숨겨져 있어도 켜져 있다 (여는 동작이기도 하므로)
    expect(actions['view.log']?.enabled).toBe(true);
    expect(actions['view.terminal']?.enabled).toBe(true);
  });

  it("최대화·숨기기는 도구 창이 보일 때만 켜지고 기본 단축키는 ⌘⇧' 와 ⇧Esc 다", () => {
    const hidden = byId(ctx());
    expect(hidden['view.dockMaximize']?.shortcut).toBe("mod+shift+'");
    expect(hidden['view.dockHide']?.shortcut).toBe('shift+escape');
    expect(hidden['view.dockMaximize']?.enabled).toBe(false);
    expect(hidden['view.dockHide']?.enabled).toBe(false);

    const c = ctx({ dock: { tool: 'terminal' } });
    const shown = byId(c);
    expect(shown['view.dockMaximize']?.enabled).toBe(true);
    expect(shown['view.dockHide']?.enabled).toBe(true);
    shown['view.dockMaximize']?.run();
    expect(c.app.toggleDockMaximized).toHaveBeenCalledTimes(1);
    shown['view.dockHide']?.run();
    expect(c.app.hideDock).toHaveBeenCalledTimes(1);
  });

  it('저장소 탭도 폴더 탭과 같다 (W21): 위쪽 영역(⌘1·⌘2)은 최대화를 풀고, 아래 도구 창 안의 로그·상세(⌘9·⌘3)는 로그 탭을 보일 뿐 최대화를 건드리지 않는다', () => {
    const c = ctx({
      active: 2,
      session: {},
      dock: { tool: 'git', maximized: true, gitTab: 'log' },
    });
    const actions = byId(c);
    for (const id of ['view.focusSidebar', 'view.focusEditor']) {
      actions[id]?.run();
      expect(c.app.setDockMaximized).toHaveBeenLastCalledWith(false);
    }
    expect(c.app.setDockMaximized).toHaveBeenCalledTimes(2);
    // ⌘1 은 Project 도구 창을 연다 (옛 사이드바가 아니라)
    expect(c.app.setLeftTool).toHaveBeenCalledWith('project');
    for (const id of ['view.focusDetail', 'view.focusGraph']) {
      actions[id]?.run();
    }
    expect(c.app.setDockMaximized).toHaveBeenCalledTimes(2);
    // 로그 탭이 이미 보이므로 도구 창을 건드리지 않는다
    expect(c.app.toggleDock).not.toHaveBeenCalled();
    expect(c.app.hideDock).not.toHaveBeenCalled();
  });

  it('최대화·숨기기는 화면에 그리는 상태를 따른다: 로그 탭은 저장소 탭에서도 보이고(W21), 탭이 없을 때(홈)만 가려진다', () => {
    const log = { tool: 'git', gitTab: 'log' } as const;
    const repo = byId(ctx({ active: 2, session: {}, dock: log }));
    expect(repo['view.dockMaximize']?.enabled).toBe(true);
    expect(repo['view.dockHide']?.enabled).toBe(true);
    const folder = byId(ctx({ active: 2, tabKind: 'folder', dock: log }));
    expect(folder['view.dockMaximize']?.enabled).toBe(true);
    expect(folder['view.dockHide']?.enabled).toBe(true);
    const home = byId(ctx({ dock: log }));
    expect(home['view.dockMaximize']?.enabled).toBe(false);
    expect(home['view.dockHide']?.enabled).toBe(false);
  });

  it('새 동작도 사용자 재지정을 따른다', () => {
    const actions = byId(ctx({ overrides: { 'view.dockHide': 'f9', 'view.dockMaximize': null } }));
    expect(actions['view.dockHide']?.shortcut).toBe('f9');
    expect(actions['view.dockMaximize']?.shortcut).toBeUndefined();
  });
});

describe('영역 포커스 동작 (5.7절)', () => {
  /** id → 동작 */
  const byId = (c: ActionContext) => Object.fromEntries(buildActions(c).map((a) => [a.id, a]));

  /** `data-panel` 영역들을 문서에 만든다. 뒤에 `*` 를 붙이면 안에 포커스 가능한 요소를 둔다 */
  function panels(...names: string[]): void {
    document.body.innerHTML = names
      .map((n) => {
        const name = n.replace('*', '');
        const inner = n.endsWith('*') ? `<div tabindex="0" data-inner="${name}"></div>` : '';
        return `<div tabindex="-1" data-panel="${name}">${inner}</div>`;
      })
      .join('');
  }

  /** 지금 포커스가 있는 곳: 영역 이름, 안쪽 요소면 `이름>inner` */
  function focused(): string | null {
    const el = document.activeElement;
    return el?.getAttribute('data-panel') ?? (el ? `${el.getAttribute('data-inner')}>inner` : null);
  }

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('기본 키: ⌘1 Project, ⌘2 에디터, ⌘3 상세, ⌘9 로그 (id 는 그대로)', () => {
    const actions = byId(ctx());
    expect(actions['view.focusSidebar']?.shortcut).toBe('mod+1');
    expect(actions['view.focusEditor']?.shortcut).toBe('mod+2');
    expect(actions['view.focusDetail']?.shortcut).toBe('mod+3');
    expect(actions['view.focusGraph']?.shortcut).toBe('mod+9');
    // 같은 기본 키를 쓰는 동작이 둘이면 뒤의 것이 죽는다
    const shortcuts = buildActions(ctx()).flatMap((a) => (a.shortcut ? [a.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('사용자가 재지정한 키는 기본 키가 바뀌어도 그대로 적용된다', () => {
    const actions = byId(
      ctx({ overrides: { 'view.focusGraph': 'mod+2', 'view.focusEditor': null } }),
    );
    expect(actions['view.focusGraph']?.shortcut).toBe('mod+2');
    expect(actions['view.focusEditor']?.shortcut).toBeUndefined();
  });

  it.each<[string, Parameters<typeof ctx>[0], Record<string, boolean>]>([
    [
      '탭이 없으면 모두 꺼진다',
      {},
      { focusSidebar: false, focusEditor: false, focusGraph: false, focusDetail: false },
    ],
    [
      '저장소 탭에서는 모두 켜진다',
      { active: 2, session: {} },
      { focusSidebar: true, focusEditor: true, focusGraph: true, focusDetail: true },
    ],
    [
      '폴더 탭에서도 모두 켜진다 (상세는 Git 도구 창 로그 탭의 오른쪽 칸, W8)',
      { active: 2, tabKind: 'folder' },
      { focusSidebar: true, focusEditor: true, focusGraph: true, focusDetail: true },
    ],
  ])('%s', (_name, partial, expected) => {
    const actions = byId(ctx(partial));
    for (const [name, enabled] of Object.entries(expected)) {
      expect(actions[`view.${name}`]?.enabled, name).toBe(enabled);
    }
  });

  it('focusPanel 은 그 이름의 영역으로 가고, 안에 포커스 가능한 것이 있으면 그것부터 준다', () => {
    panels('project*', 'editor', 'git-log*', 'sidebar', 'center');
    focusPanel('editor');
    expect(focused()).toBe('editor');
    focusPanel('project');
    expect(focused()).toBe('project>inner');
    focusPanel('git-log');
    expect(focused()).toBe('git-log>inner');
  });

  it.each<[Parameters<typeof focusPanel>[0], string]>([
    ['project', 'sidebar'],
    ['editor', 'center'],
    ['git-log', 'center'],
    ['git-detail', 'detail'],
  ])('옛 3단 배치의 영역(%s → %s)으로 가는 폴백은 없다 (W21 에서 걷었다)', (name) => {
    panels('sidebar*', 'center*', 'detail*');
    focusPanel(name);
    expect(document.activeElement).toBe(document.body);
  });

  it('대응하는 영역이 어디에도 없으면 포커스를 옮기지 않는다', () => {
    panels('project', 'editor');
    focusPanel('editor');
    focusPanel('git-detail');
    expect(focused()).toBe('editor');
  });

  it('폴더 탭의 ⌘1 은 Project 도구 창을 열고, 화면이 바뀐 뒤 포커스를 준다', () => {
    vi.useFakeTimers();
    panels('project*', 'editor');
    const c = ctx({ active: 2, tabKind: 'folder', dock: { tool: 'git', maximized: true } });
    byId(c)['view.focusSidebar']?.run();
    expect(c.app.setLeftTool).toHaveBeenCalledWith('project');
    expect(c.app.setDockMaximized).toHaveBeenCalledWith(false);
    // 접혀 있던 영역이 펴진 다음이어야 하므로 바로 주지 않는다
    expect(focused()).not.toBe('project>inner');
    vi.runAllTimers();
    expect(focused()).toBe('project>inner');
  });

  it('폴더 탭의 ⌘2 는 최대화를 풀고 에디터 공간에 포커스를 준다', () => {
    vi.useFakeTimers();
    panels('project*', 'editor');
    const c = ctx({ active: 2, tabKind: 'folder', dock: { tool: 'git', maximized: true } });
    byId(c)['view.focusEditor']?.run();
    expect(c.app.setDockMaximized).toHaveBeenCalledWith(false);
    vi.runAllTimers();
    expect(focused()).toBe('editor');
  });

  it.each<[string, Partial<DockState>, boolean]>([
    ['숨겨져 있으면 로그를 연다', { tool: null, gitTab: 'log' }, true],
    ['콘솔 탭이면 로그 탭으로 바꾼다', { tool: 'git', gitTab: 'console' }, true],
    ['터미널이 보이면 로그로 바꾼다', { tool: 'terminal', gitTab: 'log' }, true],
    ['로그가 이미 보이면 그대로 둔다', { tool: 'git', gitTab: 'log' }, false],
  ])('폴더 탭의 ⌘9: %s', (_name, dock, opens) => {
    vi.useFakeTimers();
    panels('editor', 'git-log*');
    const c = ctx({ active: 2, tabKind: 'folder', dock });
    byId(c)['view.focusGraph']?.run();
    if (opens) {
      expect(c.app.toggleDock).toHaveBeenCalledWith('git', 'log');
    } else {
      expect(c.app.toggleDock).not.toHaveBeenCalled();
    }
    // 로그를 보려는 것이므로 최대화는 건드리지 않는다
    expect(c.app.setDockMaximized).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(focused()).toBe('git-log>inner');
  });

  it.each<[string, Partial<DockState>, boolean]>([
    ['숨겨져 있으면 로그 탭을 연다', { tool: null, gitTab: 'log' }, true],
    ['콘솔 탭이면 로그 탭으로 바꾼다', { tool: 'git', gitTab: 'console' }, true],
    ['로그 탭이 이미 보이면 그대로 둔다', { tool: 'git', gitTab: 'log' }, false],
  ])('폴더 탭의 ⌘3: %s. 상세 칸(변경 파일 트리)에 포커스를 준다', (_name, dock, opens) => {
    vi.useFakeTimers();
    panels('editor', 'git-log*', 'git-detail*');
    const c = ctx({ active: 2, tabKind: 'folder', dock });
    byId(c)['view.focusDetail']?.run();
    if (opens) {
      expect(c.app.toggleDock).toHaveBeenCalledWith('git', 'log');
    } else {
      expect(c.app.toggleDock).not.toHaveBeenCalled();
    }
    // 상세는 아래 도구 창 안에 있으므로 최대화를 풀지 않는다
    expect(c.app.setDockMaximized).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(focused()).toBe('git-detail>inner');
  });

  it('저장소 탭의 ⌘1·⌘0·⌘2·⌘9·⌘3 은 폴더 탭과 같은 영역(Project·Commit·에디터·로그·상세)으로 간다 (W21)', () => {
    vi.useFakeTimers();
    panels('project*', 'commit*', 'editor', 'git-log*', 'git-detail*');
    const c = ctx({ active: 2, session: {}, dock: { tool: null, gitTab: 'log' } });
    const actions = byId(c);
    const steps: [string, string][] = [
      ['view.focusSidebar', 'project>inner'],
      ['view.toolCommit', 'commit>inner'],
      ['view.focusEditor', 'editor'],
      ['view.focusGraph', 'git-log>inner'],
      ['view.focusDetail', 'git-detail>inner'],
    ];
    for (const [id, target] of steps) {
      actions[id]?.run();
      vi.runAllTimers();
      expect(focused(), id).toBe(target);
    }
    expect(c.app.setLeftTool).toHaveBeenNthCalledWith(1, 'project');
    expect(c.app.setLeftTool).toHaveBeenNthCalledWith(2, 'commit');
    // 로그·상세는 숨겨진 Git 도구 창의 로그 탭을 연다
    expect(c.app.toggleDock).toHaveBeenCalledWith('git', 'log');
  });

  it('팔레트의 Pull Requests 도구 창은 그 영역(`pull-requests`)의 목록에 포커스를 준다 (W24 — 기본 키는 없다)', () => {
    vi.useFakeTimers();
    panels('project*', 'pull-requests*', 'editor');
    const c = ctx({
      active: 2,
      session: {
        remoteProject: { accountId: null, kind: 'github', host: 'h', project: 'p', remote: 'o' },
      } as never,
    });
    byId(c)['view.toolPullRequests']?.run();
    vi.runAllTimers();
    expect(focused()).toBe('pull-requests>inner');
    expect(c.app.setLeftTool).toHaveBeenCalledWith('pullRequests');
  });

  it('저장소 탭의 ⌘W 도 에디터에 포커스가 있으면 에디터 탭만 닫고, 밖이면 탭을 닫는다 (결정 7번, W21)', () => {
    panels('editor*', 'git-log*');
    const closeEditorDoc = vi.fn(() => true);
    const c = { ...ctx({ active: 2, session: {} }), closeEditorDoc };
    const close = byId(c)['repo.close'];
    focusPanel('editor');
    close?.run();
    expect(closeEditorDoc).toHaveBeenCalledTimes(1);
    expect(c.app.requestCloseSession).not.toHaveBeenCalled();
    focusPanel('git-log');
    close?.run();
    expect(closeEditorDoc).toHaveBeenCalledTimes(1);
    expect(c.app.requestCloseSession).toHaveBeenCalledWith(2);
  });

  it('저장소 탭의 새 영역 동작도 사용자 재지정을 따른다 (WS-20)', () => {
    const actions = byId(
      ctx({
        active: 2,
        session: {},
        overrides: { 'view.toolCommit': 'f7', 'view.focusGraph': null },
      }),
    );
    expect(actions['view.toolCommit']?.shortcut).toBe('f7');
    expect(actions['view.toolCommit']?.enabled).toBe(true);
    expect(actions['view.focusGraph']?.shortcut).toBeUndefined();
  });
});

describe('matchShortcut', () => {
  const ev = (
    key: string,
    mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
  ) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it('mod 는 플랫폼 주 수정키이고 나머지 수정키는 정확히 일치해야 한다', () => {
    const mac = /Mac/.test(navigator.platform ?? '');
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    expect(matchShortcut(ev('p', { ...mod, shiftKey: true }), 'mod+shift+p')).toBe(true);
    expect(matchShortcut(ev('P', { ...mod, shiftKey: true }), 'mod+shift+p')).toBe(true);
    expect(matchShortcut(ev('p', mod), 'mod+shift+p')).toBe(false);
    expect(matchShortcut(ev('p', { ...mod, shiftKey: true, altKey: true }), 'mod+shift+p')).toBe(
      false,
    );
    expect(matchShortcut(ev('F8'), 'f8')).toBe(true);
    expect(matchShortcut(ev('F8', mod), 'f8')).toBe(false);
  });

  it("⌘⇧' 는 웹뷰가 키를 ' 로 주든 \" 로 주든 맞는다", () => {
    const mac = /Mac/.test(navigator.platform ?? '');
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    expect(matchShortcut(ev("'", { ...mod, shiftKey: true }), "mod+shift+'")).toBe(true);
    expect(matchShortcut(ev('"', { ...mod, shiftKey: true }), "mod+shift+'")).toBe(true);
    // Shift 없이는 맞지 않고, Shift 글자는 Shift 가 든 표기에만 쓴다
    expect(matchShortcut(ev("'", mod), "mod+shift+'")).toBe(false);
    expect(matchShortcut(ev('"', { ...mod, shiftKey: true }), "mod+'")).toBe(false);
    // 이미 쓰던 조합의 판정은 그대로다
    expect(matchShortcut(ev(']', { ...mod, shiftKey: true }), 'mod+shift+]')).toBe(true);
  });

  it('⇧Esc 는 Shift 만 눌렀을 때 맞는다', () => {
    expect(matchShortcut(ev('Escape', { shiftKey: true }), 'shift+escape')).toBe(true);
    expect(matchShortcut(ev('Escape'), 'shift+escape')).toBe(false);
    expect(matchShortcut(ev('Escape', { shiftKey: true, altKey: true }), 'shift+escape')).toBe(
      false,
    );
  });

  it('새 단축키도 화면 표기로 바뀐다', () => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');
    expect(formatShortcut("mod+shift+'")).toBe(mac ? "⌘⇧'" : "Ctrl+Shift+'");
    expect(formatShortcut('shift+escape')).toBe(mac ? '⇧Escape' : 'Shift+Escape');
  });
});

describe('⌘F·⌘⇧G 의 탭 종류별 뜻 (5.7절, W17)', () => {
  /** id → 동작 */
  const byId = (c: ActionContext) => Object.fromEntries(buildActions(c).map((a) => [a.id, a]));

  /** 로그 영역 안의 필터 바 (텍스트 칸·첫 드롭다운) */
  function filterBar(text = ''): HTMLInputElement {
    document.body.innerHTML = `<div tabindex="-1" data-panel="git-log">
      <div data-filter-bar>
        <input data-filter-text value="${text}" />
        <button type="button" data-filter-first>저장소</button>
        <button type="button">branch</button>
      </div>
      <div tabindex="0" data-inner="git-log"></div>
    </div>`;
    return document.querySelector('[data-filter-text]') as HTMLInputElement;
  }

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('동작 id·기본 키는 그대로다', () => {
    const actions = byId(ctx());
    expect(actions['view.search']?.shortcut).toBe('mod+f');
    expect(actions['view.graphFilter']?.shortcut).toBe('mod+shift+g');
  });

  it.each<[string, Partial<DockState>, boolean]>([
    ['로그가 숨겨져 있으면 연다', { tool: null, gitTab: 'log' }, true],
    ['콘솔 탭이면 로그 탭으로', { tool: 'git', gitTab: 'console' }, true],
    ['로그가 보이면 그대로', { tool: 'git', gitTab: 'log' }, false],
  ])(
    '폴더 탭의 ⌘F: %s. 화면이 바뀐 뒤 필터 텍스트 칸에 포커스하고 글자를 전체 선택한다',
    (_n, dock, opens) => {
      vi.useFakeTimers();
      const input = filterBar('fix:');
      const c = ctx({ active: 2, tabKind: 'folder', dock });
      const actions = byId(c);
      expect(actions['view.search']?.enabled).toBe(true);
      actions['view.search']?.run();
      if (opens) {
        expect(c.app.toggleDock).toHaveBeenCalledWith('git', 'log');
      } else {
        expect(c.app.toggleDock).not.toHaveBeenCalled();
      }
      expect(document.activeElement).not.toBe(input);
      vi.runAllTimers();
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
    },
  );

  it('폴더 탭의 ⌘⇧G 는 로그 탭을 열고 필터 바의 첫 드롭다운에 포커스한다', () => {
    vi.useFakeTimers();
    filterBar();
    const c = ctx({ active: 2, tabKind: 'folder', dock: { tool: null, gitTab: 'log' } });
    const actions = byId(c);
    expect(actions['view.graphFilter']?.enabled).toBe(true);
    actions['view.graphFilter']?.run();
    expect(c.app.toggleDock).toHaveBeenCalledWith('git', 'log');
    vi.runAllTimers();
    expect(document.activeElement?.hasAttribute('data-filter-first')).toBe(true);
  });

  it('저장소 탭: ⌘F = 그래프 찾기 줄, ⌘⇧G = 필터 바의 텍스트 칸(전체 선택). 찾기 줄·필터 바가 든 로그 탭이 안 보이면 먼저 연다 (W21·W26)', () => {
    vi.useFakeTimers();
    const input = filterBar('fix:');
    // 로그 탭이 보일 때: 도구 창을 건드리지 않고 찾기 줄을 열고, ⌘⇧G 는 필터 바 텍스트 칸으로 (옛 필터 바 열기/닫기는 없다)
    const shown = ctx({
      active: 2,
      session: {},
      dock: { tool: 'git', gitTab: 'log' },
    });
    const a = byId(shown);
    a['view.search']?.run();
    expect(shown.session?.setSearchOpen).toHaveBeenCalledWith(true);
    a['view.graphFilter']?.run();
    vi.runAllTimers();
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
    expect(shown.app.toggleDock).not.toHaveBeenCalled();
    // 콘솔 탭일 때: 로그 탭을 열고 찾기 줄을 연다 / 로그 탭을 열고 필터 바 텍스트 칸으로
    input.blur();
    const hidden = ctx({
      active: 2,
      session: {},
      dock: { tool: 'git', gitTab: 'console' },
    });
    const b = byId(hidden);
    b['view.search']?.run();
    expect(hidden.app.toggleDock).toHaveBeenLastCalledWith('git', 'log');
    expect(hidden.session?.setSearchOpen).toHaveBeenCalledWith(true);
    b['view.graphFilter']?.run();
    expect(hidden.app.toggleDock).toHaveBeenCalledTimes(2);
    vi.runAllTimers();
    expect(document.activeElement).toBe(input);
  });

  it('탭이 없으면 둘 다 꺼진다', () => {
    const actions = byId(ctx());
    expect(actions['view.search']?.enabled).toBe(false);
    expect(actions['view.graphFilter']?.enabled).toBe(false);
  });
});

describe('팔레트·단축키 대화상자의 제목 정리 (W27) — 동작 id·순서·기본 키는 그대로', () => {
  /** 모든 동작의 기본 키 (사용자 재지정이 이 id 로 저장된다 — 바뀌면 안 된다, WS-20) */
  const DEFAULT_KEYS: Record<string, string | undefined> = {
    'repo.open': 'mod+o',
    'repo.close': 'mod+w',
    'repo.nextTab': 'mod+shift+]',
    'repo.prevTab': 'mod+shift+[',
    'view.refresh': 'mod+r',
    'sync.fetch': 'mod+shift+f',
    'sync.pull': 'mod+shift+l',
    'sync.push': 'mod+shift+k',
    'view.search': 'mod+f',
    'view.terminal': 'mod+shift+j',
    'view.graphFilter': 'mod+shift+g',
    'view.focusSidebar': 'mod+1',
    'view.focusGraph': 'mod+9',
    'view.focusDetail': 'mod+3',
    'branch.quickSwitch': 'mod+b',
    'branch.create': 'mod+shift+b',
    'branch.stash': 'mod+shift+s',
    'view.log': 'mod+j',
    'external.editor': 'mod+shift+e',
    'external.terminal': 'mod+shift+t',
    'app.settings': 'mod+,',
    'edit.undo': 'mod+z',
    'edit.redo': 'mod+shift+z',
    'view.dockMaximize': "mod+shift+'",
    'view.dockHide': 'shift+escape',
    'view.focusEditor': 'mod+2',
    'view.toolCommit': 'mod+0',
  };

  it('W20~W26 으로 뜻이 바뀐 동작의 제목이 지금 동작을 말한다', () => {
    const titles = Object.fromEntries(
      buildActions(ctx({ active: 2, session: {} })).map((a) => [a.id, a.title]),
    );
    expect({
      graphFilter: titles['view.graphFilter'],
      focusSidebar: titles['view.focusSidebar'],
      focusGraph: titles['view.focusGraph'],
      focusDetail: titles['view.focusDetail'],
      log: titles['view.log'],
    }).toEqual({
      graphFilter: '포커스: 로그 필터',
      focusSidebar: 'Project 도구 창',
      focusGraph: '포커스: Git 로그',
      focusDetail: '포커스: Git 로그 상세',
      log: 'Git 콘솔 열기/닫기',
    });
    // 그대로 둔 제목: 뜻이 바뀌지 않았다 (⌘F 찾기·⌘0·⌘2·Pull Requests 도구 창)
    expect(titles['view.search']).toBe(S.actions.search);
    expect(titles['view.toolCommit']).toBe('Commit 도구 창');
    expect(titles['view.focusEditor']).toBe('포커스: 에디터');
  });

  it('동작 id·순서와 모든 기본 키가 그대로다', () => {
    const list = buildActions(ctx({ active: 2, session: {} }));
    expect(list.map((a) => a.id).slice(0, LEGACY_IDS.length)).toEqual(LEGACY_IDS);
    const keys = Object.fromEntries(
      list.filter((a) => a.shortcut !== undefined).map((a) => [a.id, a.shortcut]),
    );
    expect(keys).toEqual(DEFAULT_KEYS);
  });
});
