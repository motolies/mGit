import { S } from '@mgit/ui';
import { type AppStore, effectiveDock, type LeftTool, type TabKind } from './store/app-store';
import type { SessionState } from './store/session-store';
import { type TagsDocRequest, tagsDoc, type WorkspaceState } from './store/workspace-store';

/** 팔레트·단축키·메뉴가 공유하는 동작 하나 (UX-02·03) */
export interface Action {
  id: string;
  title: string;
  group: keyof typeof S.palette.groups;
  /** `mod+shift+p` 꼴. 없으면 팔레트에서만 */
  shortcut?: string;
  enabled: boolean;
  run: () => void;
}

/** 동작이 쓰는 앱 상태 */
export type ActionApp = Pick<
  AppStore,
  | 'activeSessionId'
  | 'sessionOrder'
  | 'isOpening'
  | 'theme'
  | 'shortcutOverrides'
  | 'templates'
  | 'dock'
  | 'pickDirectory'
  | 'cloneRepository'
  | 'initRepository'
  | 'openRepository'
  | 'requestCloseSession'
  | 'setActiveSession'
  | 'refreshActive'
  | 'toggleDock'
  | 'hideDock'
  | 'toggleDockMaximized'
  | 'setDockMaximized'
  | 'setLeftTool'
  | 'setAppDialog'
  | 'setShortcutsOpen'
  | 'openExternal'
  | 'setSettingsOpen'
  | 'setTheme'
>;

/** 동작이 쓰는 세션 상태 */
export type ActionSession = Pick<
  SessionState,
  | 'busy'
  | 'op'
  | 'refs'
  | 'path'
  | 'status'
  | 'undoState'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'setSearchOpen'
  | 'openRepoSettings'
  | 'stashPush'
  | 'undo'
  | 'redo'
  | 'setReflogOpen'
  | 'openFileBackups'
  | 'remoteProject'
  | 'checkRemoteTags'
>;

/** 동작이 읽을 상태. 훅이 아니라 호출 시점의 스냅샷이다 */
export interface ActionContext {
  app: ActionApp;
  /** 활성 저장소 세션 상태 (폴더 탭·없음이면 null) */
  session: ActionSession | null;
  /** 활성 탭의 종류 (탭이 없으면 null). 영역 포커스와 아래 도구 창의 뜻이 탭 종류에 따라 다르다 */
  tabKind: TabKind | null;
  /** 빠른 branch 전환 열기 (App 의 로컬 상태) */
  openQuickSwitch: () => void;
  /** 홈 화면의 clone/init 흐름 */
  startClone: () => void;
  startInit: () => void;
  /** 이름 입력 대화상자 (branch 만들기) */
  promptBranch: () => void;
  /** 두 ref 비교 대화상자 (DIFF-06) */
  promptCompare: () => void;
  /** 그래프 열 설정 (GRAPH-12) */
  promptColumns: () => void;
  /**
   * 에디터 공간의 활성 탭을 닫는다 (결정 7번 — ⌘W 는 에디터에 포커스가 있을 때만 에디터 탭을 닫는다). 닫을 탭이 없으면
   * false. 주지 않으면 ⌘W 는 언제나 탭(폴더·저장소)을 닫는다
   */
  closeEditorDoc?: () => boolean;
  /**
   * 저장소 탭의 태그 문서를 연다 (C3a, `openTagsDoc`). 요청(C4: 모든 tag push 등)을 함께 줄 수 있다. 주지 않으면 팔레트의
   * "tag 관리"·"모든 tag push…" 가 꺼진다
   */
  openTagsDoc?: (request?: TagsDocRequestInput) => void;
}

/**
 * 포커스를 옮길 수 있는 화면 영역 (`data-panel` 이름). 폴더 탭·저장소 탭이 같은 이름을 쓴다 (W21). Git 도구 창 로그
 * 탭의 왼쪽 칸(`git-branches`)은 저장소 탭에서 아직 옛 사이드바다 (W22 가 브랜치 트리로 바꾼다). `pull-requests` 는
 * 저장소 탭의 Pull Requests 도구 창(W24)이다
 */
export type PanelName =
  | 'project'
  | 'commit'
  | 'pull-requests'
  | 'editor'
  | 'git-log'
  | 'git-detail';

/** 왼쪽 도구 창 → 그 영역 이름 (`data-panel`). 왼쪽 자리(`WorkspaceShell` 의 `leftPanel`)와 포커스 이동이 같은 이름을 쓴다 */
export const LEFT_TOOL_PANEL = {
  project: 'project',
  commit: 'commit',
  pullRequests: 'pull-requests',
} as const satisfies Record<LeftTool, PanelName>;

/**
 * 영역 안에서 키보드를 받을 요소 (W19 ③): ① 활성 문서(탭 패널) 안의 키보드 대상(`tabindex="0"` 이나 편집기 본문) →
 * ② 영역 안의 첫 `tabindex="0"`(트리·로그·활성 탭 — 분할선은 뺀다) → ③ 첫 조작 요소(빈 에디터의 "개요 열기" 등) →
 * ④ 영역 자신
 */
export function focusTargetIn(panel: HTMLElement): HTMLElement {
  const notSeparator = ':not([role="separator"])';
  return (
    panel.querySelector<HTMLElement>(
      `[role="tabpanel"] [tabindex="0"]${notSeparator}, [role="tabpanel"] .cm-content`,
    ) ??
    panel.querySelector<HTMLElement>(`[tabindex="0"]${notSeparator}`) ??
    panel.querySelector<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select, textarea',
    ) ??
    panel
  );
}

/**
 * 영역에 키보드 포커스를 준다 (UX-10, W19 ③). 영역 안의 키보드 대상(`focusTargetIn`)부터. 그 이름의 영역이 화면에
 * 없으면(접힌 도구 창이 아직 그려지지 않았다 등) 아무것도 하지 않는다 — 옛 배치로 가는 폴백은 W21 에서 걷었다
 */
export function focusPanel(name: PanelName): void {
  if (typeof document === 'undefined') {
    return;
  }
  const panel = document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
  if (!panel) {
    return;
  }
  focusTargetIn(panel).focus();
}

/** 지금 키보드 포커스가 그 영역(`data-panel`) 안에 있는지 */
export function focusIsIn(name: PanelName): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.activeElement?.closest?.(`[data-panel="${name}"]`) != null;
}

/** 아래 도구 창 슬롯 표시 (`BottomDock` 의 도구 창 자리) */
export const DOCK_ATTR = 'data-dock';

/** 지금 키보드 포커스가 아래 도구 창 안에 있는지 */
function focusIsInDock(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.activeElement?.closest?.(`[${DOCK_ATTR}]`) != null;
}

/**
 * 도구 창을 열거나 최대화를 푼 뒤 영역에 포커스를 준다. 상태 변경이 화면에 반영된 다음이어야 하므로
 * (접혀 있던 영역은 `inert` 이고, 로그 탭은 보일 때 마운트된다) 한 박자 늦춘다
 */
function focusPanelSoon(name: PanelName): void {
  setTimeout(() => focusPanel(name), 0);
}

/** 여는 쪽이 주는 태그 문서 요청 (차례는 `openTagsDoc` 이 붙인다) */
export type TagsDocRequestInput =
  | { kind: 'pushAll'; remote: string | null }
  | { kind: 'remoteOnly'; remote: string };

// 태그 문서 요청의 차례 (같은 요청을 다시 해도 새 요청으로 보이게)
let tagsRequestSeq = 0;

/**
 * 저장소 탭의 태그 문서를 연다 (C3a, TG-10 ①): 고정 탭으로 열고(이미 있으면 그 탭을 보인다) 에디터 공간 — 문서의 목록
 * — 에 포커스를 준다. 요청(C4)이 있으면 문서가 받아 처리한다 (모든 tag push 는 그 뒤 push 단추로 포커스를 옮긴다).
 * 트리 Tags 묶음의 단추·메뉴와 팔레트가 같이 쓴다. 워크스페이스가 없으면 아무것도 하지 않는다
 */
export function openTagsDoc(
  ws: Pick<WorkspaceState, 'openDoc' | 'setTagsView'> | null | undefined,
  repoPath: string,
  repoName: string,
  request?: TagsDocRequestInput,
): void {
  if (!ws) {
    return;
  }
  if (request) {
    tagsRequestSeq += 1;
    ws.setTagsView({ request: { ...request, seq: tagsRequestSeq } as TagsDocRequest });
  }
  ws.openDoc(tagsDoc({ repoPath, repoName }), 'pinned');
  focusPanelSoon('editor');
}

/**
 * 왼쪽 도구 창(Project·Commit·Pull Requests)을 열고 그 영역에 포커스를 준다 (⌘1·⌘0, 팔레트의 Pull Requests 도구 창,
 * 저장소 탭 상세 빈 상태의 "Commit 도구 창 열기"). 아래 도구 창이 본문을 덮고 있으면(최대화) 먼저 푼다. 접혀 있던 영역은
 * 화면이 바뀐 뒤에 포커스한다
 */
export function showLeftTool(
  app: Pick<ActionApp, 'setLeftTool' | 'setDockMaximized'>,
  tool: LeftTool,
): void {
  app.setLeftTool(tool);
  app.setDockMaximized(false);
  focusPanelSoon(LEFT_TOOL_PANEL[tool]);
}

/**
 * Commit 도구 창의 변경 탭(충돌 목록이 맨 위)을 열고 그 영역에 포커스를 준다 (W23). 사용자가 누른 길이 쓴다 — 작업 진행
 * 띠의 충돌 수·"충돌 해결"(충돌 파일 여럿), 그래프의 WIP 행, 상세 칸 빈 상태의 "Commit 도구 창 열기". Stash 탭을 보던
 * 중이어도 변경 탭으로 바꾼다(`revealCommitChanges` — 충돌 자동 활성화와 같은 길). ⌘0·왼쪽 띠의 Commit 단추는 이것이
 * 아니라 `showLeftTool`·`toggleLeftTool` 로 마지막에 보던 탭을 그대로 연다
 */
export function showCommitChanges(
  app: Pick<AppStore, 'revealCommitChanges' | 'setDockMaximized'>,
): void {
  app.revealCommitChanges();
  app.setDockMaximized(false);
  focusPanelSoon('commit');
}

/** 로그 필터 바에서 포커스를 줄 곳: 텍스트·해시 칸(⌘F) / 첫 드롭다운(⌘⇧G) */
export type LogFilterPart = 'text' | 'first';

/** `view.search` 의 기본 키 (저장소 탭 필터 바의 찾기 단추 툴팁도 이 값을 보인다 — 사용자가 바꿨으면 그 값, W26) */
export const SEARCH_SHORTCUT = 'mod+f';

/**
 * 로그 필터 바의 그 요소에 포커스를 준다 (폴더 탭의 ⌘F·⌘⇧G, 5.7절). 텍스트 칸이면 이미 있는 글자를 전체 선택해 바로
 * 고쳐 쓸 수 있게 한다. 로그 영역에 필터 바가 없으면 아무것도 하지 않는다
 */
export function focusLogFilter(part: LogFilterPart): void {
  if (typeof document === 'undefined') {
    return;
  }
  const bar = document.querySelector('[data-panel="git-log"] [data-filter-bar]');
  const el = bar?.querySelector<HTMLElement>(
    part === 'text' ? '[data-filter-text]' : '[data-filter-first]',
  );
  if (!el) {
    return;
  }
  el.focus();
  if (el instanceof HTMLInputElement) {
    el.select();
  }
}

/** 사용자 재지정(UX-04)을 적용한다: null 은 해제 */
function applyOverrides(list: Action[], overrides: Record<string, string | null>): Action[] {
  return list.map((a) => {
    const o = overrides[a.id];
    if (o === undefined) {
      return a;
    }
    const { shortcut: _drop, ...rest } = a;
    return o === null ? rest : { ...rest, shortcut: o };
  });
}

/** 동작 목록을 만든다. 순서가 팔레트 표시 순서 */
export function buildActions(ctx: ActionContext): Action[] {
  return applyOverrides(buildDefaultActions(ctx), ctx.app.shortcutOverrides ?? {});
}

/** 기본 단축키가 달린 동작 목록 */
function buildDefaultActions(ctx: ActionContext): Action[] {
  const { app, session } = ctx;
  const hasRepo = session !== null;
  const busy = session?.busy ?? false;
  const inOp = (session?.op ?? null) !== null;
  const hasRemotes = (session?.refs.remotes.length ?? 0) > 0;
  const current = session?.refs.labels.find((l) => l.isCurrent) ?? null;
  const repoPath = session?.path ?? null;
  const activeId = app.activeSessionId;
  const order = app.sessionOrder;
  const idx = activeId === null ? -1 : order.indexOf(activeId);
  const tabAt = (i: number) => order[(i + order.length) % order.length];
  const inFolder = ctx.tabKind === 'folder';
  // 저장소 탭 세션의 원격 프로젝트 종류 (Pull Requests 도구 창을 보일 수 있는가 — 폴더 탭은 세션이 null 이라 없음)
  const remoteKind = session?.remoteProject?.kind ?? null;
  const dockVisible = effectiveDock(app.dock, ctx.tabKind).tool !== null;
  // Git 도구 창의 로그 탭이 지금 보이는지 (폴더 탭·저장소 탭 모두 로그가 이 탭에 있다, W21)
  const logShown = app.dock.tool === 'git' && app.dock.gitTab === 'log';
  /** 위쪽 영역으로 포커스를 옮긴다. 아래 도구 창이 본문을 덮고 있으면(최대화) 먼저 푼다 */
  const focusTop = (name: PanelName) => {
    app.setDockMaximized(false);
    focusPanelSoon(name);
  };
  /** Git 도구 창의 로그 탭이 보이게 한다 (숨겨져 있거나 다른 탭이면 연다. 최대화는 건드리지 않는다) */
  const showGitLog = () => {
    if (!logShown) {
      app.toggleDock('git', 'log');
    }
  };
  /** Git 도구 창 로그 탭의 영역(로그·상세)을 열고 포커스한다. 폴더 탭·저장소 탭이 같다 (W21) */
  const focusGitLogTab = (name: 'git-log' | 'git-detail') => {
    showGitLog();
    focusPanelSoon(name);
  };
  /**
   * 폴더 탭의 ⌘F·⌘⇧G, 저장소 탭의 ⌘⇧G (5.7절): 로그 탭을 열고 필터 바에 포커스를 준다. 보기 동작이다 — 숨은 저장소
   * 세션의 검색·필터를 건드리지 않는다 (W13 허용 목록 밖). 로그 탭은 보일 때 마운트되므로 한 박자 늦춘다
   */
  const focusFilter = (part: LogFilterPart) => {
    showGitLog();
    setTimeout(() => focusLogFilter(part), 0);
  };

  return [
    {
      id: 'repo.open',
      title: S.actions.openRepo,
      group: 'repo',
      shortcut: 'mod+o',
      enabled: !app.isOpening,
      run: () => void app.openRepository(),
    },
    {
      id: 'repo.clone',
      title: S.actions.clone,
      group: 'repo',
      enabled: !app.isOpening,
      run: ctx.startClone,
    },
    {
      id: 'repo.init',
      title: S.actions.init,
      group: 'repo',
      enabled: !app.isOpening,
      run: ctx.startInit,
    },
    {
      // 결정 7번: 에디터에 포커스가 있으면 에디터 탭을 닫고(닫을 탭이 없으면 아무것도 하지 않는다 — 마지막 에디터 탭을
      // 닫은 뒤 한 번 더 눌러 폴더 탭이 닫히지 않게), 아니면 탭(폴더·저장소)을 닫는다. 초안·하위 탭 확인은 각 닫기의 몫이다
      id: 'repo.close',
      title: S.actions.closeTab,
      group: 'repo',
      shortcut: 'mod+w',
      enabled: activeId !== null,
      run: () => {
        if (ctx.tabKind !== null && ctx.closeEditorDoc && focusIsIn('editor')) {
          // 닫힌 탭과 함께 포커스가 사라지므로 화면이 바뀐 뒤 에디터 공간(다음 활성 문서)에 다시 준다
          if (ctx.closeEditorDoc()) {
            focusPanelSoon('editor');
          }
          return;
        }
        if (activeId !== null) {
          void app.requestCloseSession(activeId);
        }
      },
    },
    {
      id: 'repo.nextTab',
      title: S.actions.nextTab,
      group: 'repo',
      shortcut: 'mod+shift+]',
      enabled: order.length > 1,
      run: () => {
        const t = tabAt(idx + 1);
        if (t !== undefined) {
          app.setActiveSession(t);
        }
      },
    },
    {
      id: 'repo.prevTab',
      title: S.actions.prevTab,
      group: 'repo',
      shortcut: 'mod+shift+[',
      enabled: order.length > 1,
      run: () => {
        const t = tabAt(idx - 1);
        if (t !== undefined) {
          app.setActiveSession(t);
        }
      },
    },
    {
      id: 'view.refresh',
      title: S.actions.refresh,
      group: 'view',
      shortcut: 'mod+r',
      enabled: activeId !== null,
      run: () => void app.refreshActive(),
    },
    {
      id: 'sync.fetch',
      title: S.actions.fetch,
      group: 'sync',
      shortcut: 'mod+shift+f',
      enabled: hasRepo && hasRemotes && !busy && !inOp,
      run: () => void session?.fetch(null, true),
    },
    {
      id: 'sync.pull',
      title: S.actions.pull,
      group: 'sync',
      shortcut: 'mod+shift+l',
      enabled: hasRepo && !!current?.upstream && !busy && !inOp,
      run: () => void session?.pull(),
    },
    {
      id: 'sync.push',
      title: S.actions.push,
      group: 'sync',
      shortcut: 'mod+shift+k',
      enabled: hasRepo && hasRemotes && !!current && !busy && !inOp,
      run: () => void session?.push(),
    },
    {
      // 저장소 탭 = 그래프 찾기 줄, 폴더 탭 = 로그 필터 바의 텍스트 칸 (5.7절, 동작 id 유지). 저장소 탭의 찾기 줄도 Git
      // 도구 창 로그 탭 안에 있으므로 로그 탭을 먼저 보인다 (W21)
      id: 'view.search',
      title: S.actions.search,
      group: 'view',
      shortcut: SEARCH_SHORTCUT,
      enabled: hasRepo || inFolder,
      run: () => {
        if (inFolder) {
          focusFilter('text');
          return;
        }
        showGitLog();
        session?.setSearchOpen(true);
      },
    },
    {
      id: 'view.terminal',
      title: S.actions.terminal,
      group: 'view',
      shortcut: 'mod+shift+j',
      enabled: true,
      run: () => app.toggleDock('terminal'),
    },
    {
      // 폴더 탭 = 로그 필터 바의 첫 드롭다운, 저장소 탭 = 필터 바의 텍스트 칸 (5.7절, 동작 id 유지). 저장소 탭은 필터 바가
      // 늘 보이고(W26 — 옛 필터 바 열기/닫기는 없어졌다) ⌘F 가 찾기 줄이라, 텍스트 칸으로 가는 키를 이것이 맡는다. 두 탭
      // 모두 로그 탭이 안 보이면 먼저 연다
      id: 'view.graphFilter',
      title: S.actions.graphFilter,
      group: 'view',
      shortcut: 'mod+shift+g',
      enabled: hasRepo || inFolder,
      run: () => focusFilter(inFolder ? 'first' : 'text'),
    },
    {
      id: 'view.columns',
      title: S.actions.columns,
      group: 'view',
      enabled: hasRepo,
      run: ctx.promptColumns,
    },
    {
      id: 'view.compare',
      title: S.actions.compare,
      group: 'view',
      enabled: hasRepo && !busy,
      run: ctx.promptCompare,
    },
    {
      id: 'view.focusSidebar',
      title: S.actions.focusSidebar,
      group: 'view',
      shortcut: 'mod+1',
      enabled: hasRepo || inFolder,
      run: () => showLeftTool(app, 'project'),
    },
    {
      id: 'view.focusGraph',
      title: S.actions.focusGraph,
      group: 'view',
      shortcut: 'mod+9',
      enabled: hasRepo || inFolder,
      run: () => focusGitLogTab('git-log'),
    },
    {
      // 상세는 Git 도구 창 로그 탭의 오른쪽 칸이다 (폴더 탭 W8, 저장소 탭 W21)
      id: 'view.focusDetail',
      title: S.actions.focusDetail,
      group: 'view',
      shortcut: 'mod+3',
      enabled: hasRepo || inFolder,
      run: () => focusGitLogTab('git-detail'),
    },
    {
      id: 'repo.settings',
      title: S.actions.repoSettings,
      group: 'repo',
      enabled: hasRepo && !busy,
      run: () => void session?.openRepoSettings(),
    },
    {
      id: 'repo.browseRemote',
      title: S.actions.browseRemote,
      group: 'repo',
      enabled: true,
      run: () => app.setAppDialog('remoteRepos'),
    },
    {
      id: 'app.accounts',
      title: S.actions.accounts,
      group: 'app',
      enabled: true,
      run: () => app.setAppDialog('accounts'),
    },
    {
      id: 'app.profiles',
      title: S.actions.profiles,
      group: 'app',
      enabled: true,
      run: () => app.setAppDialog('profiles'),
    },
    {
      id: 'app.sshKeys',
      title: S.actions.sshKeys,
      group: 'app',
      enabled: true,
      run: () => app.setAppDialog('sshKeys'),
    },
    {
      id: 'app.shortcuts',
      title: S.actions.shortcuts,
      group: 'app',
      enabled: true,
      run: () => app.setShortcutsOpen(true),
    },
    {
      id: 'branch.quickSwitch',
      title: S.actions.quickSwitch,
      group: 'branch',
      shortcut: 'mod+b',
      enabled: hasRepo && !busy,
      run: ctx.openQuickSwitch,
    },
    {
      id: 'branch.create',
      title: S.actions.createBranch,
      group: 'branch',
      shortcut: 'mod+shift+b',
      enabled: hasRepo && !busy,
      run: ctx.promptBranch,
    },
    {
      id: 'branch.stash',
      title: S.actions.stashSave,
      group: 'branch',
      shortcut: 'mod+shift+s',
      enabled:
        hasRepo &&
        !busy &&
        !inOp &&
        session.status.summary.staged +
          session.status.summary.unstaged +
          session.status.summary.untracked >
          0,
      run: () => void session?.stashPush(null, true, false, []),
    },
    {
      id: 'view.log',
      title: S.actions.toggleLog,
      group: 'view',
      shortcut: 'mod+j',
      enabled: true,
      run: () => app.toggleDock('git', 'console'),
    },
    {
      id: 'external.editor',
      title: S.actions.openEditor,
      group: 'external',
      shortcut: 'mod+shift+e',
      enabled: repoPath !== null,
      run: () => repoPath && void app.openExternal('editor', repoPath),
    },
    {
      id: 'external.terminal',
      title: S.actions.openTerminal,
      group: 'external',
      shortcut: 'mod+shift+t',
      enabled: repoPath !== null,
      run: () => repoPath && void app.openExternal('terminal', repoPath),
    },
    {
      id: 'external.reveal',
      title: S.actions.reveal,
      group: 'external',
      enabled: repoPath !== null,
      run: () => repoPath && void app.openExternal('reveal', repoPath),
    },
    {
      id: 'app.settings',
      title: S.actions.settings,
      group: 'app',
      shortcut: 'mod+,',
      enabled: true,
      run: () => app.setSettingsOpen(true),
    },
    {
      id: 'app.themeLight',
      title: S.actions.themeLight,
      group: 'app',
      enabled: app.theme !== 'light',
      run: () => app.setTheme('light'),
    },
    {
      id: 'app.themeDark',
      title: S.actions.themeDark,
      group: 'app',
      enabled: app.theme !== 'dark',
      run: () => app.setTheme('dark'),
    },
    {
      id: 'app.themeSystem',
      title: S.actions.themeSystem,
      group: 'app',
      enabled: app.theme !== 'system',
      run: () => app.setTheme('system'),
    },
    {
      id: 'edit.undo',
      title: session?.undoState.entries[0]
        ? S.safety.undoOf(session.undoState.entries[0].label)
        : S.safety.undo,
      group: 'repo',
      shortcut: 'mod+z',
      enabled: hasRepo && !busy && (session?.undoState.entries.length ?? 0) > 0,
      run: () => void session?.undo(),
    },
    {
      id: 'edit.redo',
      title: S.safety.redo,
      group: 'repo',
      shortcut: 'mod+shift+z',
      enabled: hasRepo && !busy && (session?.undoState.redoCount ?? 0) > 0,
      run: () => void session?.redo(),
    },
    {
      id: 'safety.reflog',
      title: S.safety.reflog,
      group: 'repo',
      enabled: hasRepo,
      run: () => session?.setReflogOpen(true),
    },
    {
      id: 'safety.fileBackups',
      title: S.safety.fileBackups,
      group: 'repo',
      enabled: hasRepo,
      run: () => void session?.openFileBackups(),
    },
    // 아래 도구 창 슬롯 (WS-03). 새 동작은 목록 끝에 더한다
    {
      id: 'view.dockMaximize',
      title: S.actions.dockMaximize,
      group: 'view',
      shortcut: "mod+shift+'",
      enabled: dockVisible,
      run: () => app.toggleDockMaximized(),
    },
    {
      id: 'view.dockHide',
      title: S.actions.dockHide,
      group: 'view',
      shortcut: 'shift+escape',
      enabled: dockVisible,
      run: () => {
        // 숨기는 도구 창 안에 포커스가 있었으면 에디터 공간으로 돌린다 (IntelliJ 와 같다 — 숨긴 창에 포커스가 남지 않게)
        const returnFocus = focusIsInDock();
        app.hideDock();
        if (returnFocus) {
          focusPanelSoon('editor');
        }
      },
    },
    // 워크스페이스 영역 (5.7절). ⌘2 는 에디터 공간이고 그래프(로그) 포커스는 ⌘9 로 옮겼다
    {
      id: 'view.focusEditor',
      title: S.actions.focusEditor,
      group: 'view',
      shortcut: 'mod+2',
      enabled: hasRepo || inFolder,
      run: () => focusTop('editor'),
    },
    // Commit 도구 창 (W14, 5.7절): Project 자리에 열고 변경 목록에 포커스한다. 폴더 탭·저장소 탭 모두 (W21). 저장소
    // 탭은 마지막에 보던 탭(변경·Stash)을 그대로 연다 (W23)
    {
      id: 'view.toolCommit',
      title: S.actions.toolCommit,
      group: 'view',
      shortcut: 'mod+0',
      enabled: hasRepo || inFolder,
      run: () => showLeftTool(app, 'commit'),
    },
    // Pull Requests 도구 창 (W24, WS-17): 기본 키는 없다 (계획 5.7절에 없음 — 팔레트와 사용자 재지정으로 쓴다). 원격
    // 프로젝트(GitHub/GitLab)가 있는 저장소 탭에서만 켜지고, 제목은 호스팅 종류를 따른다. 열고 목록에 포커스한다
    {
      id: 'view.toolPullRequests',
      title: S.actions.toolPullRequests(S.pr.title(remoteKind ?? 'github')),
      group: 'view',
      enabled: remoteKind !== null,
      run: () => showLeftTool(app, 'pullRequests'),
    },
    // 원격 tag 확인 (B5, TG-09 ③): 모든 원격의 tag 상태를 받아 브랜치 칸에 보인다. 기본 키는 없다. 쓰기가 아니라 busy 와
    // 무관하다 (D15)
    {
      id: 'sync.checkRemoteTags',
      title: S.actions.checkRemoteTags,
      group: 'sync',
      enabled: hasRepo && hasRemotes,
      run: () => void session?.checkRemoteTags(),
    },
    // tag 관리 (C3a, TG-10 ①): 저장소 탭의 태그 문서를 고정 탭으로 열고 목록에 포커스한다. 기본 키는 없다
    {
      id: 'view.tagsDoc',
      title: S.actions.tagsDoc,
      group: 'view',
      enabled: hasRepo && ctx.openTagsDoc !== undefined,
      run: () => {
        app.setDockMaximized(false);
        ctx.openTagsDoc?.();
      },
    },
    // 모든 tag push (C4, TG-13): 문서를 열고 기본 원격을 확인한 뒤 "로컬에만" 을 모두 골라 push 단추에 포커스한다 —
    // 보내는 것은 사용자가 검토한 뒤 그 단추로 한다. 원격은 문서 머리에서 바꿀 수 있다. 기본 키는 없다
    {
      id: 'sync.pushAllTags',
      title: S.actions.pushAllTags,
      group: 'sync',
      enabled: hasRepo && hasRemotes && ctx.openTagsDoc !== undefined,
      run: () => {
        app.setDockMaximized(false);
        ctx.openTagsDoc?.({ kind: 'pushAll', remote: null });
      },
    },
  ];
}
