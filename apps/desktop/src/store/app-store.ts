import {
  type BatchResult,
  type CloneBatchRequest,
  type CloneRequest,
  type DeviceCodes,
  type ExternalApps,
  type ExternalKind,
  type FolderOpened,
  type FoundRepo,
  type GitignoreTemplate,
  GraphRangeCache,
  type GroupListItem,
  type GroupUpdate,
  type HostingAccount,
  type HostingUrls,
  type HostKind,
  type IpcClient,
  type OauthConfig,
  type Profile,
  type RecentEntry,
  type RepoOpened,
  type RepoPage,
  type SessionEvent,
  type SessionId,
  type SshKeyInfo,
  tauriGraphSource,
  toIpcError,
} from '@mgit/ipc';
import { getLocale, type Locale, S } from '@mgit/ui';
import { create, type StoreApi } from 'zustand';
import { commitRevealStep, EMPTY_COMMIT_REVEAL } from './commit-reveal';
import {
  existingFiles,
  readSavedEditorTabs,
  restoreEditorTabs,
  retainSavedEditorTabs,
  type SavedEditorTabs,
  watchEditorTabs,
  writeSavedEditorTabs,
} from './editor-tabs-persist';
import { describeError } from './errors';
import { markExplicitRefresh } from './explicit-refresh';
import { guardFileEditorClose } from './file-editor-close';
import { fileEditors } from './file-editor-store';
import { createFolderStore } from './folder-store';
import {
  finishOpenGroupEdit,
  groupPathMove,
  memberChanges,
  prepareOpenGroupEdit,
} from './group-reshape';
import {
  applyLanguage,
  type LanguagePreference,
  loadLanguagePreference,
  readSystemLocale,
  resolveLanguage,
  saveLanguagePreference,
} from './language';
import { type Notice, notifyHub, type ToastKind } from './notify';
import { readPref, writePref } from './prefs';
import { watchRecentFiles } from './recent-files';
import {
  activeRepoLocked,
  asBorrowed,
  type FolderCloseRisk,
  folderCloseRisks,
  foldersUsing,
  heldCount,
  LIGHT_SESSIONS_PER_FOLDER,
  ledgerReferences,
  pickEvictable,
  type RepoSessionEntry,
  type RepoSessionLedger,
  type RepoSessionLedgers,
  reconcileLedger,
  sessionBusy,
  sessionHasWork,
  withoutSession,
} from './repo-sessions';
import { forgetRootPrefs, moveRootPrefPaths } from './root-prefs';
import { groupIdOf, groupKey } from './root-space';
import { type SessionCloseMode, type SessionClosePlan, sessionCloseTargets } from './session-close';
import {
  disposeFolder,
  disposeSession,
  disposeWorkspace,
  getFolderStore,
  getSessionStore,
  getWorkspaceStore,
  registerFolder,
  registerSession,
  registerWorkspace,
} from './session-registry';
import { tabSpace } from './session-space';
import {
  createSessionStore,
  type OperationState,
  repoNameOf,
  type SessionDocSlot,
  type SessionState,
  type SessionStoreOptions,
} from './session-store';
import { groupTabOrder, PREF_TAB_PARENTS, tabParentPaths } from './tab-order';
import {
  applyTheme,
  loadThemePreference,
  readSystemDark,
  resolveTheme,
  saveThemePreference,
  type ThemePreference,
} from './theme';
import {
  conflictDocId,
  createWorkspaceStore,
  docRepoPath,
  isSessionDoc,
  openConflictDraft,
  repoSessionDocs,
  sessionDocSlot,
  sessionDocsOf,
  type WorkspaceStore,
} from './workspace-store';

export { describeError } from './errors';

/** 토스트 하나 (UX-09) */
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

/** git·ssh 가 묻는 자격 증명 하나 (AU-01) */
export interface CredentialRequest {
  reqId: number;
  kind: string;
  target: string;
  prompt: string;
  /** 받은 시각 (ms). 코어가 포기한 요청을 내리는 데 쓴다 */
  receivedAt: number;
}

/** 진행 중인 외부 앱 열기를 가리키는 키 */
export function externalKey(kind: ExternalKind, path: string): string {
  return `${kind}:${path}`;
}

/** 앱 수준 대화상자 이름 (B1) */
export type AppDialog = 'accounts' | 'profiles' | 'sshKeys' | 'remoteRepos';

const PREF_SHORTCUTS = 'mgit.shortcuts';
/** 아래 도구 창 슬롯에서 열려 있던 도구 창과 Git 탭 (WS-04). 최대화는 저장하지 않는다 */
const PREF_DOCK = 'mgit.bottomDock';
/** 왼쪽 도구 창 슬롯에서 열려 있던 도구 창 (WS-04). 값은 `{ tool }` 이고 닫혀 있으면 tool 이 null */
const PREF_LEFT_TOOL = 'mgit.leftTool';
const TOAST_MS = 6000;
/** 코어가 자격 증명 응답을 기다리는 시간 (`PROMPT_TIMEOUT`). 지나면 늦은 답은 버려진다 */
const CREDENTIAL_TTL_MS = 5 * 60_000;
/** 기억할 자격 증명 대상 수 */
const CREDENTIAL_TARGETS = 20;
/** 자동 fetch 간격의 기본값 (분). 코어가 저장된 값이 없을 때 쓰는 값과 같다 */
export const DEFAULT_AUTO_FETCH_MINUTES = 5;
let nextToastId = 1;

export type { LoadState } from './session-store';

/** 아래 도구 창 슬롯에 들어가는 도구 창 (WS-02). 한 번에 하나만 보인다 */
export type DockTool = 'git' | 'terminal';

/** Git 도구 창의 탭. 배열 순서가 화면 순서이고 첫 항목이 기본 탭이다. 작업 기록은 폴더 탭에만 있다 */
export const GIT_DOCK_TABS = ['log', 'history', 'console'] as const;
export type GitDockTab = (typeof GIT_DOCK_TABS)[number];
/** 저장소 탭의 Git 탭: 작업 기록(폴더 일괄 작업)이 없다 */
const REPO_DOCK_TABS: readonly GitDockTab[] = GIT_DOCK_TABS.filter((t) => t !== 'history');
/** 탭이 없을 때(홈)의 Git 탭: 그릴 로그·기록이 없어 콘솔만이다 */
const HOME_DOCK_TABS: readonly GitDockTab[] = ['console'];

/** 아래 도구 창 슬롯의 상태: {숨김, Git, 터미널} × {보통, 최대화} (WS-02·03) */
export interface DockState {
  /** 보이는 도구 창. null 이면 슬롯이 숨겨져 있다 */
  tool: DockTool | null;
  /** 슬롯이 위쪽 본문을 덮고 있는지. 숨겨져 있으면 항상 false 이고 재시작하면 false 로 돌아간다 */
  maximized: boolean;
  /** Git 도구 창에서 고른 탭. 다른 도구 창이 보이거나 숨겨져 있어도 기억한다 */
  gitTab: GitDockTab;
}

/** 처음 실행했을 때의 슬롯: Git 도구 창의 로그 탭이 보인다 (WS-01). 사용자가 숨기면 숨긴 채로 저장된다 */
export const DEFAULT_DOCK: DockState = { tool: 'git', maximized: false, gitTab: GIT_DOCK_TABS[0] };

/** 도구 창을 보인다. Git 은 탭을 주면 그 탭으로 바꾼다. 숨김에서 열면 보통 크기, 도구 창만 바꾸면 최대화는 그대로 */
export function dockShown(dock: DockState, tool: DockTool, gitTab?: GitDockTab): DockState {
  return {
    tool,
    maximized: dock.tool !== null && dock.maximized,
    gitTab: tool === 'git' && gitTab !== undefined ? gitTab : dock.gitTab,
  };
}

/** 슬롯을 숨긴다. 최대화도 함께 풀린다 (숨김 × 최대화 상태는 없다) */
export function dockHidden(dock: DockState): DockState {
  return { ...dock, tool: null, maximized: false };
}

/**
 * 도구 창 단축키·버튼의 뜻 (IntelliJ 도구 창 방식): 그 도구 창(과 탭)이 보이고 있으면 숨기고,
 * 다른 도구 창·다른 탭이 보이거나 숨겨져 있으면 그것을 보인다
 */
export function dockToggled(dock: DockState, tool: DockTool, gitTab?: GitDockTab): DockState {
  const showing =
    dock.tool === tool && (tool !== 'git' || gitTab === undefined || dock.gitTab === gitTab);
  return showing ? dockHidden(dock) : dockShown(dock, tool, gitTab);
}

/** 최대화를 켜고 끈다. 숨겨져 있으면 켜지지 않는다 */
export function dockMaximized(dock: DockState, on: boolean): DockState {
  return { ...dock, maximized: on && dock.tool !== null };
}

/**
 * 저장된 값을 슬롯 상태로 바꾼다. `tool: null` 은 사용자가 숨긴 것이므로 그대로 두고,
 * 모르는 도구 창·탭은 기본값으로 돌리며 최대화는 복원하지 않는다
 */
export function restoreDock(saved: { tool?: unknown; gitTab?: unknown }): DockState {
  const tool =
    saved.tool === 'git' || saved.tool === 'terminal' || saved.tool === null
      ? saved.tool
      : DEFAULT_DOCK.tool;
  const gitTab = GIT_DOCK_TABS.find((t) => t === saved.gitTab) ?? DEFAULT_DOCK.gitTab;
  return { tool, maximized: false, gitTab };
}

/**
 * 탭 종류에서 쓸 수 있는 Git 탭 (화면 순서). 폴더 탭은 로그·작업 기록·콘솔, 저장소 탭은 로그와 콘솔이다 (W21 — 저장소
 * 탭의 로그도 이 자리로 들어왔다). 탭이 없으면(홈) 그릴 로그가 없어 콘솔만이다
 */
export function gitDockTabsFor(kind: TabKind | null): readonly GitDockTab[] {
  switch (kind) {
    case 'folder':
      return GIT_DOCK_TABS;
    case 'repo':
      return REPO_DOCK_TABS;
    default:
      return HOME_DOCK_TABS;
  }
}

/**
 * 화면에 그릴 슬롯 상태. 고른 Git 탭을 지금 탭 종류에서 쓸 수 없으면, 탭이 있을 때(폴더·저장소)는 첫 탭(로그)으로
 * 그리고 홈은 슬롯이 숨겨진 것처럼 그린다 — 폴더 탭에서 작업 기록을 보다 저장소 탭으로 가도 도구 창이 사라지지 않는다.
 * 저장된 상태는 건드리지 않으므로, 그 탭을 쓸 수 있는 탭으로 돌아오면 다시 그 탭이 보인다
 */
export function effectiveDock(dock: DockState, kind: TabKind | null): DockState {
  const tabs = gitDockTabsFor(kind);
  if (dock.tool !== 'git' || tabs.includes(dock.gitTab)) {
    return dock;
  }
  const first = tabs[0];
  return kind !== null && first !== undefined ? { ...dock, gitTab: first } : dockHidden(dock);
}

/**
 * 왼쪽 도구 창 슬롯에 들어가는 도구 창 (WS-05). 같은 자리에 한 번에 하나만 뜨고 폭은 함께 쓴다. 폴더 탭·저장소 탭이
 * 같은 상태를 쓴다 (W21). 배열 순서가 왼쪽 띠의 순서다. Pull Requests(W24, WS-17)는 원격 프로젝트(GitHub/GitLab)가 있는
 * 저장소 탭에서만 보일 수 있다 — 저장된 값과 지금 보이는 것을 `effectiveLeftTool` 이 가른다
 */
const LEFT_TOOLS = ['project', 'commit', 'pullRequests'] as const;
export type LeftTool = (typeof LEFT_TOOLS)[number];

/** 처음 실행했을 때의 왼쪽 도구 창: Project 가 열려 있다 */
export const DEFAULT_LEFT_TOOL: LeftTool | null = LEFT_TOOLS[0];

/**
 * 지금 보일 왼쪽 도구 창 (W24). 저장된 값이 Pull Requests 인데 지금 탭에서 보일 수 없으면(폴더 탭, 원격 프로젝트가 없는
 * 저장소 탭, 원격 프로젝트를 아직 못 읽음) Project 를 보인다. 저장된 값은 건드리지 않으므로 PR 을 보일 수 있는 탭으로
 * 돌아오면(또는 원격 프로젝트가 늦게 오면) 다시 PR 이 보인다 — 아래 도구 창의 `effectiveDock` 과 같은 방식이다.
 * 띠의 강조·왼쪽 영역의 내용과 `data-panel`·띠 단추의 접기가 모두 이 값을 본다
 */
export function effectiveLeftTool(tool: LeftTool | null, prAvailable: boolean): LeftTool | null {
  return tool === 'pullRequests' && !prAvailable ? 'project' : tool;
}

/**
 * 지금 활성 탭에서 Pull Requests 도구 창을 보일 수 있는지 (W24): 저장소 탭이고 그 세션에 원격 프로젝트가 있다(계정 연결
 * 여부와 무관 — 도구 창 안에서 계정 연결을 안내한다). 그 순간의 세션 상태를 읽는다 — 화면은 세션 변화를 구독하는 훅
 * (`store/use-left-tool.ts` 의 `useShownLeftTool`)으로 같은 판단을 한다
 */
export function prToolAvailable(s: Pick<AppStore, 'sessions' | 'activeSessionId'>): boolean {
  if (activeTabKind(s) !== 'repo' || s.activeSessionId === null) {
    return false;
  }
  return (getSessionStore(s.activeSessionId)?.getState().remoteProject ?? null) !== null;
}

/**
 * 저장소 탭 Commit 도구 창의 탭 (WS-22, W23): 변경(변경 목록 + 커밋 입력) | Stash. 배열 순서가 화면 순서이고 첫 항목이
 * 기본 탭이다. 왼쪽 도구 창처럼 앱 전역 1벌이고 저장하지 않는다 (앱을 켜면 변경 탭). 폴더 탭의 Commit 도구 창(폴더
 * 모드)에는 탭이 없어 이 값을 보지 않는다
 */
export const COMMIT_TABS = ['changes', 'stash'] as const;
export type CommitTab = (typeof COMMIT_TABS)[number];

/** 저장된 값을 왼쪽 도구 창으로 바꾼다. `tool: null` 은 사용자가 닫은 것이고 모르는 값은 기본값이다 */
export function restoreLeftTool(saved: { tool?: unknown }): LeftTool | null {
  if (saved.tool === null) {
    return null;
  }
  return LEFT_TOOLS.find((t) => t === saved.tool) ?? DEFAULT_LEFT_TOOL;
}

/**
 * 그룹 대화상자 요청: 새 그룹(이름·처음 넣을 경로를 미리 채울 수 있다 — "이 폴더로 그룹 만들기") 또는 그룹 편집
 */
export type GroupDialogRequest =
  | { mode: 'create'; name?: string; paths?: readonly string[] }
  | { mode: 'edit'; id: string };

/** 탭 하나의 직렬화 가능한 메타데이터. 나머지 상태는 세션·폴더 스토어에 있다 */
export interface SessionMeta {
  id: SessionId;
  kind: 'repo' | 'folder';
  path: string;
  name: string;
  /** 폴더 탭에서 연 하위 저장소면 그 폴더 세션 */
  parent: SessionId | null;
}

/** 탭 종류: 저장소 / 여러 저장소가 든 폴더 */
export type TabKind = SessionMeta['kind'];

/** 활성 탭의 종류. 탭이 없으면 null */
export function activeTabKind(s: Pick<AppStore, 'sessions' | 'activeSessionId'>): TabKind | null {
  return s.activeSessionId === null ? null : (s.sessions[s.activeSessionId]?.kind ?? null);
}

/**
 * 화면에 그릴 슬롯 상태 (`effectiveDock`). 새 객체일 수 있으므로 스토어 selector 에서는 이 결과의 값
 * 하나를 골라 쓴다 (`useAppStore((s) => shownDock(s).tool)`)
 */
export function shownDock(
  s: Pick<AppStore, 'dock' | 'sessions' | 'activeSessionId'> &
    Partial<Pick<AppStore, 'homeVisible'>>,
): DockState {
  return s.homeVisible ? dockHidden(s.dock) : effectiveDock(s.dock, activeTabKind(s));
}

export interface AppStoreDeps {
  client: IpcClient;
  /** 폴더 선택 대화상자. `title` 은 창 제목 그대로다 (부르는 흐름이 용도에 맞게 정한다). 취소하면 null */
  pickDirectory: (title: string, defaultPath?: string) => Promise<string | null>;
}

export interface AppStore {
  sessions: Record<SessionId, SessionMeta>;
  sessionOrder: SessionId[];
  activeSessionId: SessionId | null;
  homeVisible: boolean;
  homeReturnSessionId: SessionId | null;
  showHome(): void;
  returnToWorkspace(): void;
  gitVersion: string | null;
  gitError: string | null;
  theme: ThemePreference;
  /** 화면 언어 선호 (다국어 L3, 저장 키 `mgit.language`) */
  language: LanguagePreference;
  /** 지금 화면 언어 (선호와 OS 로캘로 정한 값). 루트가 이 값을 key 로 써서 바뀌면 화면을 다시 마운트한다 */
  uiLocale: Locale;
  /** 읽어 둔 OS 로캘 (BCP 47). 아직 읽지 않았거나 읽지 못했으면 null */
  systemLocale: string | null;
  isOpening: boolean;
  lastError: string | null;
  /** 아래 도구 창 슬롯: Git(명령 로그 SF-01)과 터미널(UX-08)이 같은 자리를 쓴다 (WS-02) */
  dock: DockState;
  /** 왼쪽 도구 창 슬롯에 열린 도구 창. null 이면 접혀 있다 (앱 전역 1벌, WS-04·05) */
  leftTool: LeftTool | null;
  /** 저장소 탭 Commit 도구 창에서 보이는 탭 (앱 전역 1벌, 저장 안 함 — W23) */
  commitTab: CommitTab;
  /**
   * IPC 클라이언트 (컴포넌트가 스트리밍 API 를 직접 쓸 때). 폴더 탭의 저장소 세션 장부(W13)도 이 값으로 코어를
   * 부른다 — 화면 테스트가 앱 전역 스토어의 이 값을 가짜로 바꿔 끼운다
   */
  client: IpcClient;
  /**
   * 폴더 탭이 쓰는 저장소 세션의 장부 (W13): 폴더 탭 id → 저장소 경로 → `{세션, 잡음 여부, 마지막 사용 시각}`.
   * 기능(파일 히스토리·blame·외부 diff 도구, 이후 작업 트리 diff·커밋·충돌)을 처음 요청할 때만 채운다. 폴더 탭의
   * 범위 세션은 활성 저장소의 항목이다 (`repo-sessions.ts` 의 `scopeSessionId`)
   */
  repoSessions: RepoSessionLedgers;
  /** 저장소 세션을 여는 중인 폴더 탭 id → 저장소 경로 ("여는 중" 표시, 그동안 활성 저장소를 잠근다) */
  repoSessionOpening: Readonly<Record<SessionId, string>>;
  /** 통합 터미널 탭 (UX-08). 슬롯이 숨겨져 있어도 탭이 있는 동안 PTY 는 살아 있다 */
  terminals: TerminalTab[];
  activeTerminal: number | null;
  /** 최근 저장소·폴더 (REPO-05) */
  recent: RecentEntry[];
  /** 진행 중인 clone (REPO-02). 세션이 없는 앱 수준 작업 */
  cloneOp: OperationState | null;
  /** `.gitignore` 템플릿 (REPO-04) */
  templates: GitignoreTemplate[];
  /** 여는 중인 외부 앱 (`externalKey`). 코어가 최대 3초 걸리므로 그동안 버튼을 막는다 */
  openingExternal: string[];
  /** 대화상자에 보이는 자격 증명 요청 (AU-01). 없으면 null */
  credentialRequest: CredentialRequest | null;
  /** 앞 요청에 답하기를 기다리는 요청들 (동시 fetch·일괄 작업) */
  credentialQueue: CredentialRequest[];
  /** 이번 실행에서 물어본 대상 (저장된 자격 증명 지우기에 제안) */
  credentialTargets: string[];
  /** 미저장 충돌 편집이 있는 저장소 탭을 닫기 전 확인 */
  closeConfirm: { id: SessionId; name: string; paths: string[] } | null;
  closeTabsConfirm: SessionClosePlan | null;
  closeTabsPending: SessionClosePlan | null;
  closeTabsRunning: boolean;
  /**
   * 폴더 탭을 닫기 전 확인 (WS-21): 함께 닫히는 하위 저장소 탭, 숨은 세션의 초안·도는 작업 (`folderCloseRisks`).
   * 저장소 탭의 확인(`closeConfirm`)과 따로 둔다 — 보이는 문구가 다르다
   */
  folderCloseConfirm: { id: SessionId; name: string; risks: FolderCloseRisk[] } | null;
  /**
   * 충돌 편집기 탭을 떠나기 전 확인 (ED-06, 저장소 탭은 W21): 저장하지 않은 편집(초안)이 있는 충돌 탭을 닫거나(`next`
   * null) 폴더 탭에서 같은 저장소의 다른 충돌 파일로 바꾸려 할 때(`next` = 그 경로). 닫아도 초안은 그 세션에 남는다
   */
  conflictLeave: ConflictLeave | null;
  /** 커맨드 팔레트 (UX-02) */
  paletteOpen: boolean;
  /** 설정 대화상자 (`⌘,`: 화면 언어·외부 앱) */
  settingsOpen: boolean;
  settingsPage: 'general' | 'shortcuts';
  /** 앱 내 토스트 (UX-09) */
  toasts: Toast[];
  /** 단축키 재지정 (UX-04): 동작 id → 단축키 (null 이면 해제) */
  shortcutOverrides: Record<string, string | null>;
  shortcutsOpen: boolean;
  /** 앱 수준 대화상자 (B1) */
  appDialog: AppDialog | null;
  hostingAccounts: HostingAccount[];
  profiles: Profile[];

  /** 폴더 선택 대화상자 */
  /** 폴더 선택 창 (`defaultPath` 가 있으면 그 폴더에서 연다) */
  pickDirectory(title: string, defaultPath?: string): Promise<string | null>;
  replyCredential(secret: string | null, remember: boolean): Promise<void>;
  /** 키체인에 저장한 대상의 자격 증명을 지운다 (AU-03). 성공 여부를 돌려준다 */
  credentialForget(target: string): Promise<boolean>;
  setPaletteOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  /** 토스트 + (창이 뒤에 있으면) OS 알림 */
  notice(notice: Notice): void;
  dismissToast(id: number): void;
  setShortcutOverrides(map: Record<string, string | null>): void;
  setShortcutsOpen(open: boolean): void;
  setAppDialog(dialog: AppDialog | null): void;
  loadHostingAccounts(): Promise<void>;
  hostingAddPat(kind: HostKind, host: string, token: string): Promise<HostingAccount | null>;
  hostingDeviceStart(kind: HostKind, host: string): Promise<DeviceCodes | null>;
  hostingDeviceFinish(
    kind: HostKind,
    host: string,
    codes: DeviceCodes,
  ): Promise<HostingAccount | null>;
  hostingRemove(id: string): Promise<void>;
  hostingOauthGet(): Promise<OauthConfig>;
  hostingOauthSet(config: OauthConfig): Promise<void>;
  hostingRepos(accountId: string, page: number, search: string): Promise<RepoPage | null>;
  hostingUrls(kind: HostKind, host: string): Promise<HostingUrls | null>;
  loadProfiles(): Promise<void>;
  saveProfiles(list: Profile[]): Promise<void>;
  sshKeys(): Promise<SshKeyInfo[]>;
  sshKeygen(name: string, comment: string, passphrase: string): Promise<SshKeyInfo | null>;
  openUrl(url: string): Promise<void>;
  /** 외부 앱으로 연다. 성공 여부를 돌려주고, 같은 대상을 여는 중이면 다시 부르지 않고 false */
  openExternal(kind: ExternalKind, path: string): Promise<boolean>;
  externalAppsGet(): Promise<ExternalApps>;
  /** 저장 실패는 lastError에 기록하고 호출자에게 거부로 전달한다. */
  externalAppsSet(apps: ExternalApps): Promise<void>;
  /** 자동 fetch 간격 (분, 0 = 끔). 읽지 못하면 기본값 5 */
  autoFetchGet(): Promise<number>;
  /** 자동 fetch 간격을 저장하고 곧바로 적용한다 (저장소 탭·폴더 탭 공용). 실패하면 사유를 `lastError` 에 둔다 */
  /** 저장 실패는 lastError에 기록하고 호출자에게 거부로 전달한다. */
  autoFetchSet(minutes: number): Promise<void>;

  /** 시작 시 git 버전을 읽고 테마를 적용하고, 탭을 복원하고, 시작 인자·앱 이벤트를 처리한다 */
  bootstrap(): Promise<void>;
  /** 폴더 선택 대화상자를 띄워 저장소를 연다 */
  openRepository(): Promise<void>;
  /** 주어진 경로를 연다: 저장소면 저장소 탭, 멀티 저장소 폴더면 폴더 탭 (REPO-01) */
  /** 저장소를 탭으로 연다. 열린(또는 이미 열려 있던) 세션 id 를 돌려주고 실패하면 null */
  openRepositoryAt(
    path: string,
    parent?: SessionId | null,
    options?: { activate: () => boolean },
  ): Promise<SessionId | null>;
  /** 멀티 저장소 폴더를 연다 (MR-01) */
  openFolderAt(path: string, options?: { activate: () => boolean }): Promise<void>;
  /**
   * 가상 그룹을 연다 (MR-13). 탭은 폴더 탭(`kind: 'folder'`)이고 경로가 `mgit-group:<id>`, 이름이 그룹 이름이다. 이미 열려
   * 있으면 그 탭으로 간다
   */
  openGroupAt(id: string, options?: { activate: () => boolean }): Promise<void>;
  /** 그룹 목록 (홈의 그룹 묶음·팔레트). 고정 먼저, 그다음 최근에 연 순 */
  groups: GroupListItem[];
  loadGroups(): Promise<void>;
  /** 그룹 대화상자 (새 그룹·그룹 편집). null 이면 닫힘 */
  groupDialog: GroupDialogRequest | null;
  setGroupDialog(request: GroupDialogRequest | null): void;
  /** 새 그룹을 만들고 연다. 실패하면 사유를 `lastError` 에 두고 false */
  createGroup(name: string, paths: readonly string[]): Promise<boolean>;
  /**
   * 그룹을 고친다 (M4). 열린 그룹도 탭을 연 채로 고친다: 빠지는 멤버(뺀 것·위치를 바꾼 것)의 파일 탭은 초안 확인 뒤
   * 닫고(취소하면 고치지 않고 false), 별칭이 바뀐 멤버의 문서·파일 탭·트리 경로는 새 별칭으로 옮긴다. 저장한 기록(편집기 탭
   * 복원·최근 파일)의 경로도 옮긴다. 코어가 거부하면 알림을 띄우고 false
   */
  updateGroup(id: string, update: GroupUpdate): Promise<boolean>;
  /**
   * 그룹을 지운다. 열린 그룹이면 그 탭을 먼저 닫는다 (취소하면 지우지 않고 false). 지우면 그 그룹 키의 화면 기록도 지운다
   */
  deleteGroup(id: string): Promise<boolean>;
  /**
   * 폴더 탭에서 저장소의 세션 기능을 쓴다 (W13): 그 저장소가 활성 저장소가 되고(다른 저장소의 범위 세션이 바쁘면
   * 거부), 장부에 세션이 있으면 그것을, 없으면 연다 — 상한(3)이면 가장 오래 안 쓴 한가한 세션을 먼저 놓는다.
   * 세션을 쓸 수 있게 되면 `run` 에 그 세션 상태를 넘긴다. 열지 못하면 사유를 알리고 false
   */
  withRepoSession(
    folder: SessionId,
    repoPath: string,
    run: (session: SessionState) => void,
  ): Promise<boolean>;
  /**
   * 세션 diff 탭을 닫는다 (W14, 저장소 탭은 W21): 그 문서의 세션(폴더 탭은 장부에서 문서의 저장소로, 저장소 탭은 탭
   * 자신의 세션)의 "지금 고른 파일" 슬롯을 비운다 — 탭은 그 슬롯에서 파생하므로 사라진다. 활성 저장소와 무관하다
   */
  closeRepoDiff(tab: SessionId, repoPath: string): void;
  /**
   * 폴더 탭에서 충돌 파일을 머지 편집기 탭으로 연다 (ED-06): `withRepoSession` 으로 그 저장소의 세션을 준비하고 그 세션의
   * 충돌 슬롯에 파일을 연 뒤 그 저장소의 충돌 탭을 보인다 (저장소당 탭 하나). 같은 저장소에서 초안이 있는 다른 충돌
   * 파일을 보던 중이면 열지 않고 확인(`conflictLeave`)을 먼저 받는다. 세션을 쓸 수 없으면 false
   */
  openRepoConflict(folder: SessionId, repoPath: string, path: string): Promise<boolean>;
  /**
   * 충돌 탭을 닫는다 (ED-06, 저장소 탭은 W21): 그 문서의 세션(`closeRepoDiff` 와 같게 찾는다)의 충돌 슬롯을 비운다.
   * 초안이 있으면 닫지 않고 확인(`conflictLeave`)을 먼저 받는다
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: 기존 동기 호출자를 보존하며 일괄 닫기는 확인 결과를 기다린다.
  closeRepoConflict(tab: SessionId, repoPath: string): void | Promise<boolean>;
  /**
   * 충돌 탭을 떠나는 확인에 답한다: 닫기(또는 다른 파일 열기)를 하고, `discard` 면 그 파일의 초안도 버린다. 버리지 않으면
   * 초안은 그 세션에 남아 같은 파일을 다시 열면 이어진다
   */
  confirmConflictLeave(discard: boolean): void;
  cancelConflictLeave(): void;
  /**
   * 여러 경로를 차례로 연다 (DnD·CLI 인자·두 번째 실행·콜드 스타트 복원). `parentOf`(`{ 자식 경로: 부모 경로 }`)를 주면
   * 그 부모 경로의 탭이 이미 열려 있을 때 하위 탭으로 연다 — 콜드 스타트 복원만 넘긴다. 부모가 없으면 독립 탭이다
   */
  openPaths(paths: readonly string[], parentOf?: Readonly<Record<string, string>>): Promise<void>;
  closeSession(id: SessionId): Promise<void>;
  /**
   * 사용자의 탭 닫기. 저장소 탭은 미저장 충돌 편집이 있으면, 폴더 탭은 잃는 것(`folderCloseRisks`: 하위 저장소 탭, 숨은
   * 세션의 초안·도는 작업)이 있으면 확인을 먼저 받는다
   */
  requestCloseSession(id: SessionId): Promise<void>;
  requestCloseTabs(id: SessionId, mode: SessionCloseMode): Promise<void>;
  confirmCloseSession(): Promise<void>;
  cancelCloseSession(): void;
  setActiveSession(id: SessionId): void;
  setTheme(pref: ThemePreference): void;
  /**
   * 시작할 때 첫 렌더 전에 한 번 (`bootstrap` 앞): 저장된 선호로 화면 언어를 정해 적용하고 Rust 에 알린다. 선호가
   * system 이면 OS 로캘을 `timeoutMs`(기본 1초) 안에 읽고, 실패하거나 시간을 넘기면 영어로 정한다
   */
  initLanguage(timeoutMs?: number): Promise<void>;
  /**
   * 화면 언어 선호를 바꾼다: 저장 → 화면 언어 결정·적용(문구·포맷·`<html lang>`) → Rust 에 알림 → `language`·`uiLocale`
   * 갱신. `uiLocale` 이 바뀌면 루트가 다시 마운트된다
   */
  setLanguage(pref: LanguagePreference): Promise<void>;
  clearError(): void;
  /**
   * 도구 창 단축키·버튼 (`dockToggled`): 보이고 있으면 숨기고 아니면 그 도구 창(과 Git 탭)을 보인다.
   * 터미널을 보이게 됐는데 탭이 없으면 하나 연다
   */
  toggleDock(tool: DockTool, gitTab?: GitDockTab): void;
  /** 슬롯을 숨긴다 (최대화도 풀린다) */
  hideDock(): void;
  /** 최대화/복원 */
  toggleDockMaximized(): void;
  /** 최대화를 켜고 끈다. `false` 가 "최대화 해제"다 (위쪽 영역으로 포커스가 가거나 문서가 열릴 때) */
  setDockMaximized(on: boolean): void;
  /** Git 도구 창의 탭을 고른다 */
  setGitDockTab(tab: GitDockTab): void;
  /** 왼쪽 도구 창을 연다. null 이면 접는다 */
  setLeftTool(tool: LeftTool | null): void;
  /**
   * 왼쪽 띠 버튼: 그 도구 창이 지금 보이고 있으면 접고 아니면 연다. 저장된 값이 아니라 보이는 것(`effectiveLeftTool`)으로
   * 판단한다 — 저장된 값이 Pull Requests 인데 이 탭에서는 Project 가 보일 때 Project 단추를 누르면 접힌다 (W24)
   */
  toggleLeftTool(tool: LeftTool): void;
  /** 저장소 탭 Commit 도구 창의 탭을 고른다. 왼쪽 도구 창은 건드리지 않는다 */
  setCommitTab(tab: CommitTab): void;
  /**
   * 왼쪽 도구 창에 Commit 을 열고(접혀 있으면 펼친다) 변경 탭을 고른다 — 충돌 목록이 Stash 탭 뒤에 가려지지 않게 하는
   * 길 하나 (W23). 충돌 자동 활성화가 그대로 부르고, 띠의 "충돌 해결"·WIP 행·상세 칸의 "Commit 도구 창 열기"는
   * `actions.ts` 의 `showCommitChanges` 로 거친다(최대화 해제·포커스를 더한다). 포커스·최대화는 건드리지 않는다
   */
  revealCommitChanges(): void;
  /** 터미널 탭을 열고 터미널 도구 창을 보인다. cwd 가 없으면 활성 세션 경로 */
  openTerminal(cwd?: string, title?: string, initialInput?: string | null): void;
  /** 터미널 탭을 닫는다. 마지막 탭이 닫히면 보이던 터미널 도구 창도 숨긴다 */
  closeTerminal(id: number): void;
  setActiveTerminal(id: number): void;
  markTerminalExited(id: number, code: number | null): void;
  /** 터미널 탭의 초기 입력을 지운다 (셸에 보낸 뒤 — 다시 마운트돼도 명령을 다시 실행하지 않게) */
  clearTerminalInput(id: number): void;
  /** 활성 세션을 새로고침한다 (Cmd+R) */
  refreshActive(): Promise<void>;
  loadRecent(): Promise<void>;
  pinRecent(path: string, pinned: boolean): Promise<void>;
  removeRecent(path: string): Promise<void>;
  /** 폴더를 골라 하위 저장소를 최근 목록에 등록한다 (REPO-06) */
  scanFolder(): Promise<void>;
  /** clone 하고 성공하면 연다 */
  cloneRepository(request: CloneRequest): Promise<boolean>;
  /**
   * 여러 저장소를 한 상위 폴더 아래에 clone 한다 (진행·취소는 단일 clone 과 같은 `cloneOp`). 끝나면 상위 폴더를 폴더 탭으로
   * 열고(이미 열려 있으면 그 탭을 보이고 다시 스캔) 그 폴더의 작업 기록에 결과를 남긴다. 실행하지 못했으면 null (사유는
   * `lastError`)
   */
  cloneRepositories(request: CloneBatchRequest): Promise<BatchResult | null>;
  cancelClone(): Promise<void>;
  /** 새 저장소를 만들고 연다 (REPO-04) */
  initRepository(path: string, defaultBranch: string, template: string | null): Promise<boolean>;
}

/** 충돌 탭을 떠나기 전 확인할 것 (ED-06) */
export interface ConflictLeave {
  /** 확인을 받은 탭: 폴더 탭, 또는 저장소 탭이면 그 탭 자신 (W21) */
  folder: SessionId;
  repoPath: string;
  /** 확인창에 보일 저장소 이름 */
  repoName: string;
  /** 초안이 있는 지금 충돌 파일 */
  path: string;
  /** 닫기면 null, 같은 저장소의 다른 충돌 파일로 바꾸기면 그 경로 */
  next: string | null;
}

/** 의존성을 주입받아 스토어를 만든다. 테스트에서는 가짜 client 를 넣는다 */
/** 터미널 탭 */
export interface TerminalTab {
  id: number;
  cwd: string;
  title: string;
  initialInput: string | null;
  exitCode?: number | null;
}

let terminalSeq = 0;

/** 알림·탭에 쓸 저장소 이름: 폴더 요약의 이름, 없으면 경로의 마지막 요소 */
function folderRepoName(folder: SessionId, repoPath: string): string {
  return (
    getFolderStore(folder)
      ?.getState()
      .summaries.find((s) => s.path === repoPath)?.name ?? repoNameOf(repoPath)
  );
}

/**
 * 세션 문서(폴더 탭의 작업 트리 diff 탭 W14·충돌 머지 편집기 탭 W15, 저장소 탭의 diff·충돌 화면 W20)를 세션 슬롯에
 * 맞춰 둔다 (계획 5.2: 저장하지 않고 파생한다). 폴더 탭은 장부의 세션들, 저장소 탭은 그 탭 자신의 세션 하나에서
 * 파생한다 — 같은 세션을 두 탭이 보면 각자의 워크스페이스에 각자 싣는다. 장부·탭 목록이 바뀌거나, 그 세션들의 "지금
 * 고른 파일"(`selectedFile`)·열린 충돌(`conflict`)·충돌을 읽는 중(`conflictLoading`)·충돌 초안(`conflictDrafts`,
 * 탭의 초안 표시)이 바뀌면 문서 목록을 다시 만든다. 세션을 놓으면(상한·재스캔·탭 닫기) 장부에서 빠지므로 탭도 사라진다.
 * 세션 스토어 구독은 장부가 가리키는 세션과 저장소 탭의 세션에만 건다
 */
function mirrorSessionDocs(store: StoreApi<AppStore>): void {
  const watched = new Map<SessionId, () => void>();

  /** 그 폴더 탭의 세션 문서를 다시 만든다 */
  const sync = (folder: SessionId) => {
    getWorkspaceStore(folder)
      ?.getState()
      .setSessionDocs(
        sessionDocsOf(
          store.getState().repoSessions[folder] ?? {},
          (session) => getSessionStore(session)?.getState() ?? null,
          (repoPath) => folderRepoName(folder, repoPath),
        ),
      );
  };

  /** 그 세션이 저장소 탭이면 그 탭의 세션 문서를 다시 만든다 (탭 자신의 세션 하나, W20) */
  const syncRepoTab = (session: SessionId) => {
    const meta = store.getState().sessions[session];
    const st = getSessionStore(session)?.getState();
    if (meta?.kind !== 'repo' || !st) {
      return;
    }
    getWorkspaceStore(session)
      ?.getState()
      .setSessionDocs(repoSessionDocs(meta.path, meta.name, st));
  };

  /** 장부가 가리키는 세션과 저장소 탭의 세션에만 구독을 건다 (빠진 세션의 구독은 푼다) */
  const rewatch = (app: AppStore) => {
    const wanted = new Set([
      ...Object.values(app.repoSessions).flatMap((ledger) =>
        Object.values(ledger).map((e) => e.session),
      ),
      ...Object.values(app.sessions).flatMap((m) => (m.kind === 'repo' ? [m.id] : [])),
    ]);
    for (const [session, off] of watched) {
      if (!wanted.has(session)) {
        off();
        watched.delete(session);
      }
    }
    for (const session of wanted) {
      const sessionStore = watched.has(session) ? undefined : getSessionStore(session);
      if (sessionStore) {
        watched.set(
          session,
          sessionStore.subscribe((now, before) => {
            if (
              now.selectedFile !== before.selectedFile ||
              now.conflict !== before.conflict ||
              now.conflictLoading !== before.conflictLoading ||
              now.conflictDrafts !== before.conflictDrafts
            ) {
              for (const { folder } of foldersUsing(store.getState().repoSessions, session)) {
                sync(folder);
              }
              syncRepoTab(session);
            }
          }),
        );
      }
    }
  };

  store.subscribe((now, before) => {
    if (now.repoSessions === before.repoSessions && now.sessions === before.sessions) {
      return;
    }
    rewatch(now);
    const folders = new Set([
      ...Object.keys(now.repoSessions),
      ...Object.keys(before.repoSessions),
    ]);
    for (const folder of folders) {
      const id = Number(folder);
      if (now.repoSessions[id] !== before.repoSessions[id]) {
        sync(id);
      }
    }
    // 새로 생긴 저장소 탭: 세션에 이미 열린 문서(승격 — 폴더에서 연 diff·충돌)를 싣는다
    for (const meta of Object.values(now.sessions)) {
      if (meta.kind === 'repo' && before.sessions[meta.id] === undefined) {
        syncRepoTab(meta.id);
      }
    }
  });
}

/**
 * 충돌이 생기면 Commit 도구 창을 한 번 연다 (WS-19, 결정 15번 — 판정은 `commitRevealStep`). 저장소 탭들의 세션 충돌
 * 수와 탭 목록·활성 탭이 바뀔 때마다 한 걸음씩 부르고, "지금 열라"면 왼쪽 도구 창을 Commit 으로 바꾸고 변경 탭을
 * 고른다(접혀 있으면 펼쳐진다 — `revealCommitChanges`). 포커스는 옮기지 않고 아래 도구 창의 최대화도 그대로 둔다 — 사용자가 누르지 않은 부수 효과다. 비활성 탭의
 * 계기는 그 탭이 활성이 될 때 쓴다. 세션 스토어 구독은 저장소 탭의 세션에만 건다
 */
function watchCommitReveal(store: StoreApi<AppStore>): void {
  let memo = EMPTY_COMMIT_REVEAL;
  const watched = new Map<SessionId, () => void>();

  /** 지금 저장소 탭들의 충돌 수로 한 걸음 */
  const step = () => {
    const app = store.getState();
    const tabs = Object.values(app.sessions).flatMap((meta) => {
      const st = meta.kind === 'repo' ? getSessionStore(meta.id)?.getState() : undefined;
      return st ? [{ id: meta.id, conflicted: st.status.summary.conflicted }] : [];
    });
    const next = commitRevealStep(memo, { tabs, active: app.activeSessionId });
    memo = next.memo;
    if (next.reveal) {
      // Stash 탭을 보던 중이어도 충돌 목록이 보이게 변경 탭을 고른다 (W23)
      app.revealCommitChanges();
    }
  };

  /** 저장소 탭의 세션에만 구독을 건다 (닫힌 탭의 구독은 푼다) */
  const rewatch = (app: AppStore) => {
    const wanted = new Set(
      Object.values(app.sessions).flatMap((m) => (m.kind === 'repo' ? [m.id] : [])),
    );
    for (const [session, off] of watched) {
      if (!wanted.has(session)) {
        off();
        watched.delete(session);
      }
    }
    for (const session of wanted) {
      const sessionStore = watched.has(session) ? undefined : getSessionStore(session);
      if (sessionStore) {
        watched.set(
          session,
          sessionStore.subscribe((now, before) => {
            if (now.status.summary.conflicted !== before.status.summary.conflicted) {
              step();
            }
          }),
        );
      }
    }
  };

  store.subscribe((now, before) => {
    if (now.sessions === before.sessions && now.activeSessionId === before.activeSessionId) {
      return;
    }
    if (now.sessions !== before.sessions) {
      rewatch(now);
    }
    step();
  });
}

/**
 * 세션 스토어가 "보여라"고 알리는 길 (W20, `SessionStoreOptions`). 부를 때 그 세션이 저장소 탭인지 보므로 폴더가 연
 * 가벼운 세션이 나중에 탭으로 승격돼도 다시 묶지 않는다. 폴더 탭은 여는 쪽이 `revealDoc` 을 부르므로 여기서 건드리지
 * 않는다 — 같은 세션을 폴더 탭이 함께 봐도 폴더 탭의 활성 탭은 바뀌지 않는다
 * - 문서: 저장소 탭의 워크스페이스에서 그 슬롯의 세션 문서를 보인다 (슬롯을 채운 뒤에 불리므로 문서가 이미 있다. 아래
 *   도구 창이 최대화돼 있으면 워크스페이스의 `onDocOpened` 가 푼다)
 * - 로그: 그 저장소 탭이 활성 탭이면 Git 도구 창의 로그 탭을 보인다 (W21 — 숨겨져 있으면 열고 콘솔·터미널이면 로그로
 *   바꾼다. 최대화는 건드리지 않는다). 에디터의 문서는 그대로다
 */
export function sessionRevealHooks(
  app: () => Pick<AppStore, 'sessions' | 'activeSessionId' | 'dock' | 'toggleDock'>,
  session: SessionId,
): Pick<SessionStoreOptions, 'onRevealDoc' | 'onRevealLog'> {
  /** 저장소 탭이면 그 탭의 워크스페이스 */
  const repoTabWorkspace = () =>
    app().sessions[session]?.kind === 'repo' ? getWorkspaceStore(session)?.getState() : undefined;
  return {
    onRevealDoc: (slot: SessionDocSlot) => {
      const ws = repoTabWorkspace();
      const doc = ws?.sessionDocs.find((d) => isSessionDoc(d) && sessionDocSlot(d) === slot);
      if (ws && doc) {
        ws.revealDoc(doc.id);
      }
    },
    onRevealLog: () => {
      const a = app();
      if (a.sessions[session]?.kind !== 'repo' || a.activeSessionId !== session) {
        return;
      }
      if (!(a.dock.tool === 'git' && a.dock.gitTab === 'log')) {
        a.toggleDock('git', 'log');
      }
    },
  };
}

/** 저장소 탭 워크스페이스가 앱 스토어에 거는 동작 */
export type RepoWorkspaceApp = Pick<
  AppStore,
  'setDockMaximized' | 'closeRepoDiff' | 'closeRepoConflict'
>;

/**
 * 저장소 탭의 워크스페이스 스토어를 만든다 (W20·W21, `rootKind: 'repo'`). 세션 문서는 탭 자신의 세션 슬롯에서
 * 파생하고(`mirrorSessionDocs`), 닫기는 폴더 탭과 같은 길이다 — diff 는 슬롯을 비우고, 충돌은 초안이 있으면 확인
 * (`conflictLeave`)을 먼저 받는다 (W21: 옛 저장소 탭에는 이 확인이 없었다). 활성 문서가 사라지면 직전 문서로 돌아가고,
 * 문서가 열리면 아래 도구 창의 최대화를 푼다 (WS-03, 폴더 탭과 같다). 등록은 `openRepositoryAt`, 해제는
 * `closeSession` 의 `disposeWorkspace`
 */
export function createRepoWorkspace(
  session: SessionId,
  app: () => RepoWorkspaceApp,
): WorkspaceStore {
  return createWorkspaceStore('repo', {
    beforeCloseFile: (path) => guardFileEditorClose([{ session, path }]),
    onDocOpened: () => app().setDockMaximized(false),
    closeSessionDoc: (doc) =>
      doc.kind === 'conflict'
        ? app().closeRepoConflict(session, doc.repoPath)
        : app().closeRepoDiff(session, doc.repoPath),
  });
}

export function createAppStore(deps: AppStoreDeps) {
  const store = create<AppStore>()((set, get, api) => {
    // 일괄 문서 닫기는 기존 충돌 확인의 선택이 끝난 뒤 다음 문서로 진행한다.
    let conflictCloseResolve: ((allowed: boolean) => void) | null = null;
    /**
     * 코어 이벤트를 해당 세션·폴더 스토어로 넘긴다. 닫힌 세션의 늦은 이벤트는 버린다. 어느 채널로 왔든 세션 id 로
     * 스토어를 찾으므로, 승격한 세션의 새 채널 이벤트도 같은 스토어로 간다 (W13). 폴더가 쓰는 저장소 세션의 상태가
     * 바뀌면 그 폴더의 요약·변경을 다시 읽는다 — 작업 트리만 바꾸는 쓰기는 `folderChanged` 가 오지 않는다
     */
    const handleEvent = (event: SessionEvent) => {
      getSessionStore(event.session)?.getState().applyEvent(event);
      getFolderStore(event.session)?.getState().applyEvent(event);
      if (event.type === 'statusChanged') {
        for (const { folder, repoPath } of foldersUsing(get().repoSessions, event.session)) {
          getFolderStore(folder)?.getState().refreshRepos([repoPath]);
        }
      }
      // 열린 그룹의 이름이 그 자리에서 바뀌었다 (M4): 탭 이름도 바꾼다
      if (event.type === 'groupChanged') {
        const meta = get().sessions[event.session];
        if (meta && meta.name !== event.group.name) {
          set({
            sessions: { ...get().sessions, [event.session]: { ...meta, name: event.group.name } },
          });
        }
      }
    };

    /**
     * 열린 탭 경로를 저장한다 (부모 폴더가 먼저 오도록 순서 유지). 하위 탭의 부모 경로 맵은 설정에 따로 둔다 — 코어의
     * 탭 목록 형식(`string[]`)은 그대로이고, 지금 열린 탭만으로 매번 새로 써서 지난 항목이 남지 않는다
     */
    const persistTabs = () => {
      const { sessions, sessionOrder } = get();
      const paths = sessionOrder.flatMap((id) => {
        const m = sessions[id];
        return m ? [m.path] : [];
      });
      deps.client.openTabsSet(paths).catch(() => {});
      writePref(PREF_TAB_PARENTS, tabParentPaths(sessionOrder, sessions));
    };

    let navigationVersion = 0;
    let directoryPicking = false;

    // 탭별 편집기 감시: 최근 파일 기록과 파일 탭 저장. 저장은 재시작 복원이 끝난 뒤에 건다
    const editorWatches = new Map<SessionId, { recent: () => void; tabs?: () => void }>();
    // 앱을 켤 때 다시 여는 루트 (그 탭의 파일 탭 저장은 복원을 마친 뒤 시작한다 — 빈 상태로 덮지 않게)
    let restoringRoots: ReadonlySet<string> = new Set();

    /** 탭의 파일 탭 저장을 건다 (이미 걸려 있으면 그대로) */
    const watchTabsOf = (id: SessionId, root: string) => {
      const entry = editorWatches.get(id);
      const ws = getWorkspaceStore(id);
      if (entry && !entry.tabs && ws) entry.tabs = watchEditorTabs(root, ws);
    };

    /** 탭의 편집기 감시를 푼다 (기다리던 저장은 버린다) */
    const stopEditorWatch = (id: SessionId) => {
      const entry = editorWatches.get(id);
      entry?.recent();
      entry?.tabs?.();
      editorWatches.delete(id);
    };

    /** 탭의 편집기 감시를 건다. 다시 여는 중인 루트는 최근 파일만 먼저 본다 */
    const watchEditorOf = (meta: SessionMeta) => {
      const ws = getWorkspaceStore(meta.id);
      if (!ws) return;
      stopEditorWatch(meta.id);
      editorWatches.set(meta.id, { recent: watchRecentFiles(meta.path, ws) });
      if (!restoringRoots.has(meta.path)) watchTabsOf(meta.id, meta.path);
    };

    /**
     * 재시작 뒤 탭 하나의 파일 탭을 다시 연다. 파일이 있는지는 부모 디렉터리 나열로만 보고, 실패하면 그 탭은 건너뛴다.
     * 끝나면(실패해도) 그 탭의 저장을 건다. 그사이 탭이 닫혔으면 아무것도 하지 않는다
     */
    const restoreTabsOf = async (id: SessionId, root: string, saved: SavedEditorTabs | null) => {
      const ws = getWorkspaceStore(id);
      if (ws && saved) {
        try {
          await restoreEditorTabs(ws, saved, (paths) =>
            existingFiles((dir, limit) => deps.client.fsListDir(id, dir, limit), paths),
          );
        } catch {
          // 복원하지 못하면 빈 탭으로 둔다
        }
      }
      if (get().sessions[id]?.path === root && getWorkspaceStore(id) === ws) watchTabsOf(id, root);
    };

    /** 탭을 등록하고 활성화한다. 하위 탭은 끝이 아니라 부모 세트의 끝에 붙는다 (세트가 갈라지지 않게) */
    const addTab = (meta: SessionMeta, activate = true) => {
      const sessions = { ...get().sessions, [meta.id]: meta };
      set({
        sessions,
        sessionOrder: groupTabOrder(
          [...get().sessionOrder.filter((s) => s !== meta.id), meta.id],
          sessions,
        ),
        activeSessionId: activate ? meta.id : get().activeSessionId,
        ...(activate ? { homeVisible: false, homeReturnSessionId: null } : {}),
      });
      persistTabs();
      watchEditorOf(meta);
    };

    /**
     * 폴더 세션 탭을 연다 (폴더·가상 그룹 공용): `open` 이 코어에서 세션을 열고, 이미 탭이 있으면 그 탭으로 간다. 폴더·
     * 워크스페이스 스토어를 만들어 등록하고 탭을 더한다. 그룹이면 탭 이름이 그룹 이름이다 (경로는 `mgit-group:<id>`)
     */
    const openFolderTab = async (
      open: (onEvent: (event: SessionEvent) => void) => Promise<FolderOpened>,
      options?: { activate: () => boolean },
    ) => {
      const version = navigationVersion;
      const activate = () => version === navigationVersion && options?.activate() !== false;
      set({ isOpening: true, lastError: null });
      const { onEvent, flush } = bufferedEvents();
      try {
        const opened = await open(onEvent);
        const id = opened.session;
        if (get().sessions[id]) {
          if (activate())
            set({ activeSessionId: id, homeVisible: false, homeReturnSessionId: null });
          flush();
          return;
        }
        const folderStore = createFolderStore(opened, deps.client);
        registerFolder(id, folderStore);
        // 문서가 열리면 본문을 덮은 아래 도구 창(최대화)을 푼다 (WS-03). 범위 세션이 바쁘면 활성 저장소를 잠근다.
        // 세션 문서를 닫으면 그 저장소 세션의 슬롯을 비운다 (W14 작업 트리 diff, W15 충돌 — 초안이 있으면 확인)
        const wsStore = createWorkspaceStore('folder', {
          beforeCloseFile: (path) => guardFileEditorClose([{ session: id, path }]),
          onDocOpened: () => get().setDockMaximized(false),
          activeRepoLocked: () => folderActiveRepoLocked(id),
          closeSessionDoc: (doc) =>
            doc.kind === 'conflict'
              ? get().closeRepoConflict(id, doc.repoPath)
              : get().closeRepoDiff(id, doc.repoPath),
        });
        registerWorkspace(id, wsStore);
        // 재스캔으로 저장소 목록이 바뀌면 장부와 활성 저장소를 맞춘다 (화면이 없는 숨은 탭에서도). 작업 트리 diff
        // 탭을 보면 그 세션을 "방금 썼다"로 고친다 (상한에서 놓을 세션 고르기, W14)
        const unwatchRepos = folderStore.subscribe((now, before) => {
          if (now.repos !== before.repos) {
            syncFolderRepos(id, now.repos);
          }
        });
        const unwatchDocs = wsStore.subscribe((now, before) => {
          if (now.activeDocId !== before.activeDocId) {
            touchShown(id);
          }
        });
        folderRepoWatches.set(id, () => {
          unwatchRepos();
          unwatchDocs();
        });
        addTab(
          {
            id,
            kind: 'folder',
            path: opened.path,
            name: opened.group?.name ?? repoNameOf(opened.path),
            parent: null,
          },
          activate(),
        );
        flush();
        void get().loadRecent();
      } catch (e) {
        set({ lastError: describeError(e) });
      } finally {
        set({ isOpening: false });
      }
    };

    /** 그 그룹을 연 탭의 세션 id (열려 있지 않으면 null) */
    const openGroupSession = (id: string): SessionId | null => {
      const key = groupKey(id);
      const meta = Object.values(get().sessions).find((m) => m.path === key);
      return meta?.id ?? null;
    };

    /**
     * 탭 닫기를 사용자 닫기와 같은 길(잃는 것이 있으면 확인, 편집기 초안 확인)로 요청하고 끝날 때까지 기다린다. 닫혔으면
     * true, 확인을 취소했거나 다른 닫기가 도는 중이면 false. 코어 세션 닫기까지 끝난 뒤에 돌아온다
     */
    const closeTabAndWait = async (id: SessionId): Promise<boolean> => {
      if (get().closeTabsRunning) return false;
      await get().requestCloseSession(id);
      if (get().closeTabsRunning) {
        await new Promise<void>((resolve) => {
          const stop = api.subscribe((s) => {
            if (!s.closeTabsRunning) {
              stop();
              resolve();
            }
          });
        });
      }
      return !get().sessions[id];
    };

    /** 보이는 자격 증명 요청의 만료 타이머 */
    let credentialTimer: ReturnType<typeof setTimeout> | null = null;

    /** 시간을 넘긴 요청을 알린다. 코어는 이미 포기해 답해도 버려진다 */
    const noteCredentialExpired = (req: CredentialRequest) => {
      get().notice({ kind: 'error', title: S.credential.expired(req.target) });
    };

    /** 큐의 다음 요청을 보여 준다. 기다리는 사이 시간을 넘긴 요청은 건너뛴다 */
    const showNextCredential = () => {
      if (credentialTimer) {
        clearTimeout(credentialTimer);
        credentialTimer = null;
      }
      const now = Date.now();
      const alive: CredentialRequest[] = [];
      for (const req of get().credentialQueue) {
        if (now - req.receivedAt < CREDENTIAL_TTL_MS) {
          alive.push(req);
        } else {
          noteCredentialExpired(req);
        }
      }
      const [next, ...rest] = alive;
      set({ credentialRequest: next ?? null, credentialQueue: rest });
      if (next) {
        credentialTimer = setTimeout(expireCredential, next.receivedAt + CREDENTIAL_TTL_MS - now);
      }
    };

    /** 보이는 요청이 시간을 넘겼다 */
    const expireCredential = () => {
      credentialTimer = null;
      const req = get().credentialRequest;
      if (req) {
        noteCredentialExpired(req);
      }
      showNextCredential();
    };

    /**
     * clone 작업의 operation 이벤트(세션 0)를 `cloneOp` 에 싣는다 — 단일 clone 과 여러 저장소 clone 이 같이 쓴다 (시작 화면·
     * 툴바의 진행·취소 표시)
     */
    const trackCloneOp = (event: SessionEvent) => {
      const op = get().cloneOp;
      switch (event.type) {
        case 'operationStarted':
          set({
            cloneOp: {
              id: event.opId,
              kind: event.kind,
              label: event.label,
              phase: '',
              percent: null,
              message: '',
              output: [],
              done: false,
              ok: false,
              cancelled: false,
              lockLeft: false,
              startedAt: Date.now(),
            },
          });
          return;
        case 'operationProgress':
          if (op) {
            set({
              cloneOp: {
                ...op,
                phase: event.phase,
                percent: event.percent ?? null,
                message: event.message,
              },
            });
          }
          return;
        case 'operationOutput':
          if (op) {
            set({ cloneOp: { ...op, output: [...op.output.slice(-199), event.text] } });
          }
          return;
        case 'operationFinished':
          if (op) {
            set({
              cloneOp: {
                ...op,
                done: true,
                ok: event.ok,
                cancelled: event.cancelled,
                message: event.message,
              },
            });
          }
          return;
        default:
          return;
      }
    };

    /** 코어가 묻는 자격 증명을 받는다. 앞 요청이 있으면 차례를 기다린다 */
    const enqueueCredential = (req: CredentialRequest) => {
      const { credentialTargets, credentialRequest, credentialQueue } = get();
      set({
        credentialTargets: [req.target, ...credentialTargets.filter((t) => t !== req.target)].slice(
          0,
          CREDENTIAL_TARGETS,
        ),
        credentialQueue: [...credentialQueue, req],
      });
      if (!credentialRequest) {
        showNextCredential();
      }
    };

    /** 슬롯 상태를 바꾸고, 저장 대상(도구 창·Git 탭)이 달라졌으면 저장한다 (WS-04) */
    const setDock = (next: DockState) => {
      const prev = get().dock;
      if (
        prev.tool === next.tool &&
        prev.maximized === next.maximized &&
        prev.gitTab === next.gitTab
      ) {
        return;
      }
      set({ dock: next });
      if (prev.tool !== next.tool || prev.gitTab !== next.gitTab) {
        writePref(PREF_DOCK, { tool: next.tool, gitTab: next.gitTab });
      }
    };

    /** 구독 전에 도착한 이벤트를 버퍼링하는 콜백 쌍 */
    const bufferedEvents = () => {
      let registered = false;
      const pending: SessionEvent[] = [];
      const onEvent = (event: SessionEvent) => {
        if (!registered) {
          pending.push(event);
          return;
        }
        handleEvent(event);
      };
      const flush = () => {
        registered = true;
        for (const event of pending) {
          handleEvent(event);
        }
      };
      return { onEvent, flush };
    };

    // ── 폴더 탭의 저장소 세션 장부 (W13). 코어 순서는 계획 부록 "W13 ② 에서 확정" 의 ③ 그대로다 ──

    /** 폴더별 장부 작업 줄: 열기·놓기를 한 줄로 세워 장부를 읽고 쓰는 사이에 다른 작업이 끼지 않게 한다 */
    const ledgerQueues = new Map<SessionId, Promise<unknown>>();
    /**
     * 폴더 탭마다의 구독 해제 함수: 폴더 스토어의 저장소 목록(재스캔 → 장부·활성 저장소 정리)과 워크스페이스의 활성
     * 문서(작업 트리 diff 탭을 보면 그 세션의 사용 시각 갱신)
     */
    const folderRepoWatches = new Map<SessionId, () => void>();

    /** 그 폴더의 장부 작업 줄 끝에 `task` 를 세운다. 앞 작업이 실패해도 다음 작업은 돈다 */
    const serial = <T>(folder: SessionId, task: () => Promise<T>): Promise<T> => {
      const run = (ledgerQueues.get(folder) ?? Promise.resolve()).then(task, task);
      const tail = run.catch(() => {});
      ledgerQueues.set(folder, tail);
      void tail.then(() => {
        if (ledgerQueues.get(folder) === tail) {
          ledgerQueues.delete(folder);
        }
      });
      return run;
    };

    /** 폴더의 장부를 바꾼다 */
    const setLedger = (folder: SessionId, ledger: RepoSessionLedger) =>
      set({ repoSessions: { ...get().repoSessions, [folder]: ledger } });

    /** 장부에 항목을 넣거나 바꾼다 */
    const putEntry = (folder: SessionId, repoPath: string, entry: RepoSessionEntry) =>
      setLedger(folder, { ...(get().repoSessions[folder] ?? {}), [repoPath]: entry });

    /** 장부에서 항목을 뺀다 */
    const dropEntry = (folder: SessionId, repoPath: string) => {
      const { [repoPath]: _gone, ...rest } = get().repoSessions[folder] ?? {};
      setLedger(folder, rest);
    };

    /**
     * 세션 스토어를 아무도 쓰지 않으면 버린다. 수명 = 그 세션을 쓰는 탭 + 그 세션을 가리키는 폴더 장부 항목.
     * 둘 다 없을 때만 해제한다 (한 세션 id 에 스토어는 하나)
     */
    const disposeIfUnused = (session: SessionId) => {
      if (!get().sessions[session] && !ledgerReferences(get().repoSessions, session)) {
        disposeSession(session);
      }
    };

    /** 세션이 바쁜지 (상한에서 놓지 않는다). 스토어가 없으면 한가하다 */
    const sessionIsBusy = (session: SessionId) => {
      const st = getSessionStore(session)?.getState();
      return st ? sessionBusy(st) : false;
    };

    /** 폴더 탭의 활성 저장소가 잠겼는지: 세션을 여는 중이거나 범위 세션이 바쁘다 (계획 5.1) */
    const folderActiveRepoLocked = (folder: SessionId) => {
      const active = getWorkspaceStore(folder)?.getState().activeRepo ?? null;
      const entry = active === null ? undefined : get().repoSessions[folder]?.[active];
      return activeRepoLocked({
        opening: get().repoSessionOpening[folder] !== undefined,
        scope: (entry ? getSessionStore(entry.session)?.getState() : undefined) ?? null,
      });
    };

    /** 알림에 쓸 저장소 이름 */
    const repoLabel = folderRepoName;

    /**
     * 폴더 탭에 지금 보이는 문서가 저장소 세션의 문서(작업 트리 diff 탭)면 그 세션. 상한에서 놓을 세션을 고를 때 이
     * 세션은 놓지 않는다 — 보고 있는 탭이 사라지지 않게 (W14)
     */
    const shownSession = (folder: SessionId): SessionId | null => {
      const ws = getWorkspaceStore(folder)?.getState();
      const doc = ws?.sessionDocs.find((d) => d.id === ws.activeDocId);
      return (doc ? get().repoSessions[folder]?.[docRepoPath(doc) ?? '']?.session : null) ?? null;
    };

    /**
     * 세션 문서가 가리키는 세션 상태 (없으면 undefined). 폴더 탭은 장부에서 문서의 저장소로 찾는다 — 활성 저장소가
     * 아니라. 저장소 탭은 탭 자신의 세션이다 (W21 — 그 탭의 세션 문서는 모두 그 세션에서 파생한다)
     */
    const repoSessionState = (tab: SessionId, repoPath: string) => {
      if (get().sessions[tab]?.kind === 'repo') {
        return getSessionStore(tab)?.getState();
      }
      const entry = get().repoSessions[tab]?.[repoPath];
      return entry ? getSessionStore(entry.session)?.getState() : undefined;
    };

    /** 확인창·알림에 쓸 저장소 이름: 저장소 탭은 탭 이름, 폴더 탭은 요약의 이름 */
    const tabRepoName = (tab: SessionId, repoPath: string) => {
      const meta = get().sessions[tab];
      return meta?.kind === 'repo' ? meta.name : folderRepoName(tab, repoPath);
    };

    /**
     * 그 세션의 충돌 슬롯에 파일을 열고 그 저장소의 충돌 탭을 보인다 (ED-06). 이미 그 파일이 열려 있으면 다시 읽지 않고
     * 보이기만 한다. 탭은 충돌 자료가 실린 뒤 파생되므로 열기가 끝난 뒤에 보인다 (실패하면 탭이 없어 아무것도 안 한다)
     */
    const openConflictIn = (
      folder: SessionId,
      repoPath: string,
      st: SessionState,
      path: string,
    ) => {
      const reveal = () => getWorkspaceStore(folder)?.getState().revealDoc(conflictDocId(repoPath));
      if (st.conflict?.path === path) {
        reveal();
        return;
      }
      void st.openConflict(path).then(reveal);
    };

    /** 보이는 세션 문서의 장부 항목을 "방금 썼다"로 고친다 (탭을 보는 것도 그 세션을 쓰는 것이다 — LRU) */
    const touchShown = (folder: SessionId) => {
      const session = shownSession(folder);
      const found = Object.entries(get().repoSessions[folder] ?? {}).find(
        ([, e]) => e.session === session,
      );
      if (found) {
        putEntry(folder, found[0], { ...found[1], usedAt: Date.now() });
      }
    };

    /** 장부 항목 하나를 놓는다: 장부에서 빼고, 쓰는 곳이 없으면 스토어를 버리고, 잡은 세션이면 코어에 놓는다 */
    const releaseEntry = async (folder: SessionId, repoPath: string) => {
      const entry = get().repoSessions[folder]?.[repoPath];
      if (!entry) {
        return;
      }
      dropEntry(folder, repoPath);
      disposeIfUnused(entry.session);
      if (entry.held) {
        // 오류가 없는 계약이다. 실패해도 장부는 이미 비웠고, 남은 잡음은 상한 오류의 회복이나 폴더 닫기가 거둔다
        await get()
          .client.folderReleaseRepoSession(folder, entry.session)
          .catch(() => {});
      }
    };

    /**
     * 코어의 `lightSessionLimit` 이 알려 준 잡은 세션 목록으로 장부를 맞춘다: 승격·닫힘을 반영하고, 프런트가 기록을
     * 잃은 잡음은 놓는다
     */
    const reconcile = async (folder: SessionId, coreHeld: readonly SessionId[]) => {
      const result = reconcileLedger(
        get().repoSessions[folder] ?? {},
        coreHeld,
        (session) => get().sessions[session] !== undefined,
      );
      setLedger(folder, result.ledger);
      for (const session of result.dropped) {
        disposeIfUnused(session);
      }
      for (const session of result.orphans) {
        await get()
          .client.folderReleaseRepoSession(folder, session)
          .catch(() => {});
        disposeIfUnused(session);
      }
    };

    /**
     * 열린 세션을 장부에 싣는다. 같은 id 의 스토어가 이미 있으면(다른 폴더 탭·저장소 탭의 것) 새로 만들지 않고 그것을
     * 쓴다. 그사이 폴더 탭이 닫혔으면 싣지 않고, 새로 잡은 세션이면 놓는다. 실은 세션 id 를 돌려준다
     */
    const adopt = (
      folder: SessionId,
      repoPath: string,
      opened: RepoOpened,
      flush: () => void,
    ): SessionId | null => {
      const id = opened.session;
      const profile = opened.profile ?? 'full';
      if (get().sessions[folder]?.kind !== 'folder') {
        if (profile === 'light') {
          void get()
            .client.folderReleaseRepoSession(folder, id)
            .catch(() => {});
        }
        return null;
      }
      if (!getSessionStore(id)) {
        const client = get().client;
        const cache = new GraphRangeCache(tauriGraphSource(client, id));
        registerSession(id, {
          cache,
          store: createSessionStore(opened, client, cache, {
            profile,
            ...sessionRevealHooks(get, id),
          }),
        });
      }
      putEntry(folder, repoPath, { session: id, held: profile === 'light', usedAt: Date.now() });
      flush();
      return id;
    };

    /**
     * 폴더 탭에서 저장소의 세션을 쓸 수 있게 한다 (장부 작업 줄 안에서 부른다). 장부에 있으면 재사용(사용 시각 갱신),
     * 없으면 연다: 잡은 세션이 상한이면 바쁘지 않은 가장 오래된 것을 놓고, 놓을 것이 없으면 열지 않고 알린다.
     * 코어가 `lightSessionLimit` 이면(장부가 어긋남) 오류의 목록으로 장부를 맞추고 한 번만 다시 시도한다
     */
    const ensureRepoSession = async (
      folder: SessionId,
      repoPath: string,
    ): Promise<SessionId | null> => {
      const known = get().repoSessions[folder]?.[repoPath];
      if (known) {
        if (getSessionStore(known.session)) {
          putEntry(folder, repoPath, { ...known, usedAt: Date.now() });
          return known.session;
        }
        dropEntry(folder, repoPath);
      }
      set({ repoSessionOpening: { ...get().repoSessionOpening, [folder]: repoPath } });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const ledger = get().repoSessions[folder] ?? {};
          if (heldCount(ledger) >= LIGHT_SESSIONS_PER_FOLDER) {
            // 바쁜 세션과 지금 화면에 보이는 문서의 세션은 놓지 않는다
            const shown = shownSession(folder);
            const victim = pickEvictable(ledger, (s) => s === shown || sessionIsBusy(s));
            if (victim === null) {
              get().notice({
                kind: 'error',
                title: S.repoSession.limitBusy(LIGHT_SESSIONS_PER_FOLDER),
              });
              return null;
            }
            await releaseEntry(folder, victim);
          }
          const { onEvent, flush } = bufferedEvents();
          try {
            const opened = await get().client.folderOpenRepoSession(folder, repoPath, onEvent);
            return adopt(folder, repoPath, opened, flush);
          } catch (e) {
            const err = toIpcError(e);
            if (err.kind === 'lightSessionLimit' && attempt === 0) {
              await reconcile(folder, err.sessions);
              continue;
            }
            get().notice({
              kind: 'error',
              title: S.repoSession.openFailed(repoLabel(folder, repoPath)),
              message: describeError(e),
            });
            return null;
          }
        }
        return null;
      } finally {
        const { [folder]: _done, ...rest } = get().repoSessionOpening;
        set({ repoSessionOpening: rest });
      }
    };

    /**
     * 폴더의 저장소 목록이 바뀌었다 (재스캔): 목록에서 빠진 활성 저장소를 비우고(숨은 탭이어도 — 화면 effect 에만
     * 기대지 않는다), 빠진 저장소의 세션을 놓는다. 놓으면 잃는 작업·초안이 있는 세션은 남겨 두고 폴더를 닫을 때 거둔다
     */
    const syncFolderRepos = (folder: SessionId, repos: readonly FoundRepo[]) => {
      const paths = new Set(repos.map((r) => r.path));
      getWorkspaceStore(folder)
        ?.getState()
        .retainActiveRepo([...paths]);
      for (const [repoPath, entry] of Object.entries(get().repoSessions[folder] ?? {})) {
        const st = getSessionStore(entry.session)?.getState();
        if (!paths.has(repoPath) && !(st && sessionHasWork(st))) {
          void serial(folder, () => releaseEntry(folder, repoPath));
        }
      }
    };

    /** `.gitignore` 템플릿 목록을 받아 둔다 (라벨은 Rust 가 지금 화면 언어로 만든다). 실패하면 이전 목록을 둔다 */
    const loadTemplates = () => {
      deps.client
        .gitignoreTemplates()
        .then((templates) => set({ templates }))
        .catch(() => {});
    };

    /** OS 로캘. 한 번 읽으면 `systemLocale` 에 두고 다시 묻지 않는다 (읽지 못했으면 다음에 system 을 고를 때 다시 읽는다) */
    const ensureSystemLocale = async (timeoutMs?: number): Promise<string | null> => {
      const known = get().systemLocale;
      if (known !== null) {
        return known;
      }
      const locale = await readSystemLocale(() => deps.client.systemLocale(), timeoutMs);
      set({ systemLocale: locale });
      return locale;
    };

    /**
     * 선호로 화면 언어를 정해 적용하고 Rust 에 알린 뒤 상태를 바꾼다. Rust 알림은 다시 마운트된 화면이 Rust 문구를 새로
     * 받기 전에 끝나게 기다린다. 실패해도 화면 언어는 바뀌었고 Rust 문구만 이전 언어로 남으므로 경고만 남긴다
     */
    const applyLanguagePreference = async (pref: LanguagePreference, timeoutMs?: number) => {
      const systemLocale =
        pref === 'system' ? await ensureSystemLocale(timeoutMs) : get().systemLocale;
      const locale = resolveLanguage(pref, systemLocale);
      applyLanguage(locale);
      try {
        await deps.client.setLanguage(locale);
      } catch (e) {
        console.warn('setLanguage failed; Rust messages keep the previous language', e);
      }
      set({ language: pref, uiLocale: locale });
    };

    // 일괄 사전 검증을 끝낸 탭만 기존 닫기 본체의 중복 확인을 건너뛴다.
    const approvedCloseIds = new Set<SessionId>();
    let closeFinishing = false;

    /** 실행 중 명령과 메시지 편집은 종료 대신 탭을 보존한다. */
    const protectedSession = (id: SessionId): boolean => {
      const st = getSessionStore(id)?.getState();
      return (
        !!st &&
        (!!st.busy ||
          !!st.committing ||
          !!st.rewordEditor ||
          Object.values(st.operations ?? {}).some((op) => !op.done))
      );
    };

    /** 요청 당시 집합에 현재 위험과 부모·자식 보호를 다시 적용한다. */
    const inspectClosePlan = (base: SessionClosePlan): SessionClosePlan => {
      const state = get();
      const requested = base.requested.filter((id) => state.sessions[id] === base.identities[id]);
      const wanted = new Set(requested);
      const protectedIds = new Set<SessionId>();
      for (const id of state.sessionOrder) {
        const meta = state.sessions[id];
        if (!meta) continue;
        if (meta.kind === 'repo' && protectedSession(id)) protectedIds.add(id);
        if (meta.kind === 'folder') {
          const folder = getFolderStore(id)?.getState();
          if (
            folder?.batchRunning ||
            Object.keys(folder?.indexWrites ?? {}).length ||
            state.repoSessionOpening[id] !== undefined ||
            Object.values(state.repoSessions[id] ?? {}).some((entry) =>
              protectedSession(entry.session),
            )
          )
            protectedIds.add(id);
          // 확인 이후 새로 열린 child는 닫지 않으며 부모의 연쇄 닫기도 막는다.
          if (
            state.sessionOrder.some(
              (child) => state.sessions[child]?.parent === id && !wanted.has(child),
            )
          )
            protectedIds.add(id);
        }
      }
      for (const id of [...protectedIds]) {
        let parent = state.sessions[id]?.parent;
        while (parent !== null && parent !== undefined && !protectedIds.has(parent)) {
          protectedIds.add(parent);
          parent = state.sessions[parent]?.parent;
        }
      }
      const targets = requested.filter((id) => !protectedIds.has(id));
      const riskData: [number, unknown][] = [];
      const risks: string[] = [];
      const seen = new Set<SessionId>();
      const collect = (id: SessionId, name: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const drafts = getSessionStore(id)?.getState().conflictDrafts ?? {};
        if (Object.keys(drafts).length) {
          riskData.push([id, drafts]);
          risks.push(...Object.keys(drafts).map((path) => S.toolbar.closeTabDraft(name, path)));
        }
      };
      for (const id of targets) {
        const meta = state.sessions[id];
        if (!meta) continue;
        collect(id, meta.name);
        if (meta.kind === 'folder') {
          for (const [path, entry] of Object.entries(state.repoSessions[id] ?? {}))
            if (entry.held) collect(entry.session, folderRepoName(id, path));
          if (base.mode === 'this')
            risks.push(
              ...targets
                .filter((child) => state.sessions[child]?.parent === id)
                .map((child) => S.folderClose.childTab(state.sessions[child]?.name ?? '')),
            );
        }
      }
      return {
        ...base,
        targets,
        protectedIds: requested.filter((id) => protectedIds.has(id)),
        risks,
        signature: JSON.stringify([targets, riskData, risks]),
      };
    };

    /** 확인창은 한 번만 만들며 단일 닫기의 기존 문구와 상태 계약도 유지한다. */
    const publishClosePlan = (plan: SessionClosePlan) => {
      const meta = get().sessions[plan.target];
      if (plan.mode === 'this' && meta?.kind === 'repo' && plan.targets.includes(plan.target)) {
        set({
          closeTabsPending: plan,
          closeTabsConfirm: null,
          folderCloseConfirm: null,
          closeConfirm: {
            id: meta.id,
            name: meta.name,
            paths: Object.keys(getSessionStore(meta.id)?.getState().conflictDrafts ?? {}),
          },
        });
      } else if (
        plan.mode === 'this' &&
        meta?.kind === 'folder' &&
        plan.targets.includes(plan.target)
      ) {
        const risks = folderCloseRisks({
          children: plan.targets
            .filter((id) => get().sessions[id]?.parent === meta.id)
            .map((id) => ({
              name: get().sessions[id]?.name ?? '',
              drafts: Object.keys(getSessionStore(id)?.getState().conflictDrafts ?? {}),
            })),
          held: Object.entries(get().repoSessions[meta.id] ?? {})
            .filter(([, entry]) => entry.held)
            .map(([path, entry]) => ({
              repoName: folderRepoName(meta.id, path),
              drafts: Object.keys(getSessionStore(entry.session)?.getState().conflictDrafts ?? {}),
              running: false,
            })),
        });
        set({
          closeTabsPending: plan,
          closeTabsConfirm: null,
          closeConfirm: null,
          folderCloseConfirm: { id: meta.id, name: meta.name, risks },
        });
      } else {
        set({
          closeTabsPending: plan,
          closeTabsConfirm: plan,
          closeConfirm: null,
          folderCloseConfirm: null,
        });
      }
    };

    /** 모든 저장·확인이 끝나기 전에는 어떤 탭도 제거하지 않는다. */
    const finishClosePlan = async (plan: SessionClosePlan) => {
      if (closeFinishing) return;
      closeFinishing = true;
      const current = inspectClosePlan(plan);
      if (current.signature !== plan.signature && current.risks.length) {
        publishClosePlan(current);
        closeFinishing = false;
        return;
      }
      set({
        closeConfirm: null,
        folderCloseConfirm: null,
        closeTabsConfirm: null,
        closeTabsPending: current,
      });
      try {
        if (!current.targets.length) return;
        const scopeIds = new Set(current.targets);
        for (const id of current.targets) {
          if (get().sessions[id]?.kind === 'folder')
            for (const entry of Object.values(get().repoSessions[id] ?? {}))
              if (entry.held) scopeIds.add(entry.session);
        }
        const scopes = [...scopeIds].map((session) => ({ session }));
        if (!(await guardFileEditorClose(scopes))) return;
        const latest = inspectClosePlan(current);
        if (latest.signature !== current.signature && latest.risks.length) {
          publishClosePlan(latest);
          return;
        }
        const closing = latest.targets;
        const activeBefore = get().activeSessionId;
        for (const id of closing) approvedCloseIds.add(id);
        // 모두 동기적으로 제거를 시작해 첫 탭의 IPC 대기 중 새 탭이 연쇄로 닫히지 않는다.
        const pending = [...closing]
          .sort(
            (a, b) =>
              Number(get().sessions[a]?.kind === 'folder') -
              Number(get().sessions[b]?.kind === 'folder'),
          )
          .map((id) => get().closeSession(id));
        approvedCloseIds.clear();
        if (!get().homeVisible && plan.mode === 'others' && get().sessions[plan.target])
          set({ activeSessionId: plan.target });
        // 하위 탭만 닫을 때 보던 탭이 닫혔으면 남은 부모 탭으로 간다 (세트 밖의 탭을 보고 있었다면 그대로 둔다)
        if (
          !get().homeVisible &&
          plan.mode === 'children' &&
          activeBefore !== null &&
          closing.includes(activeBefore) &&
          get().sessions[plan.target]
        )
          set({ activeSessionId: plan.target });
        persistTabs();
        await Promise.all(pending);
      } catch (error) {
        get().notice({
          kind: 'error',
          title: S.toolbar.closeTabsConfirm,
          message: describeError(error),
        });
      } finally {
        closeFinishing = false;
        approvedCloseIds.clear();
        if (!get().closeTabsConfirm && !get().closeConfirm && !get().folderCloseConfirm)
          set({ closeTabsPending: null, closeTabsRunning: false });
      }
    };

    return {
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      homeVisible: false,
      homeReturnSessionId: null,
      gitVersion: null,
      gitError: null,
      theme: loadThemePreference(),
      language: loadLanguagePreference(),
      uiLocale: getLocale(),
      systemLocale: null,
      isOpening: false,
      lastError: null,
      dock: restoreDock(
        readPref<{ tool: unknown; gitTab: unknown }>(PREF_DOCK, {
          tool: DEFAULT_DOCK.tool,
          gitTab: DEFAULT_DOCK.gitTab,
        }),
      ),
      leftTool: restoreLeftTool(
        readPref<{ tool: unknown }>(PREF_LEFT_TOOL, { tool: DEFAULT_LEFT_TOOL }),
      ),
      commitTab: COMMIT_TABS[0],
      client: deps.client,
      repoSessions: {},
      repoSessionOpening: {},
      terminals: [],
      activeTerminal: null,
      recent: [],
      groups: [],
      groupDialog: null,
      cloneOp: null,
      templates: [],
      openingExternal: [],
      credentialRequest: null,
      credentialQueue: [],
      credentialTargets: [],
      closeConfirm: null,
      closeTabsConfirm: null,
      closeTabsPending: null,
      closeTabsRunning: false,
      folderCloseConfirm: null,
      conflictLeave: null,
      paletteOpen: false,
      settingsOpen: false,
      settingsPage: 'general',
      toasts: [],
      shortcutOverrides: readPref<Record<string, string | null>>(PREF_SHORTCUTS, {}),
      shortcutsOpen: false,
      appDialog: null,
      hostingAccounts: [],
      profiles: [],

      pickDirectory(title, defaultPath) {
        return defaultPath === undefined
          ? deps.pickDirectory(title)
          : deps.pickDirectory(title, defaultPath);
      },

      async replyCredential(secret, remember) {
        const req = get().credentialRequest;
        if (!req) {
          return;
        }
        showNextCredential();
        await deps.client.credentialReply(req.reqId, secret, remember).catch(() => {});
      },

      async credentialForget(target) {
        try {
          await deps.client.credentialForget(target);
          get().notice({ kind: 'success', title: S.credential.forgotten(target) });
          return true;
        } catch (e) {
          set({ lastError: describeError(e) });
          return false;
        }
      },

      setPaletteOpen(open) {
        set({ paletteOpen: open });
      },

      setSettingsOpen(open) {
        set({ settingsOpen: open, shortcutsOpen: false, settingsPage: 'general' });
      },

      notice(notice) {
        const id = nextToastId++;
        const toast: Toast = {
          id,
          kind: notice.kind,
          title: notice.title,
          message: notice.message,
        };
        set({ toasts: [...get().toasts.slice(-4), toast] });
        setTimeout(() => get().dismissToast(id), TOAST_MS);
        const hidden = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
        if (notice.os && hidden) {
          void deps.client.notify(notice.title, notice.message ?? '').catch(() => {});
        }
      },

      dismissToast(id) {
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      },

      setShortcutOverrides(map) {
        set({ shortcutOverrides: map });
        writePref(PREF_SHORTCUTS, map);
      },

      setShortcutsOpen(open) {
        set({ shortcutsOpen: open, settingsOpen: open, settingsPage: 'shortcuts' });
      },

      setAppDialog(dialog) {
        set({ appDialog: dialog, lastError: null });
      },

      async loadHostingAccounts() {
        try {
          set({ hostingAccounts: await deps.client.hostingAccounts() });
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async hostingAddPat(kind, host, token) {
        try {
          const a = await deps.client.hostingAddPat(kind, host, token);
          await get().loadHostingAccounts();
          set({ lastError: null });
          return a;
        } catch (e) {
          set({ lastError: describeError(e) });
          return null;
        }
      },

      async hostingDeviceStart(kind, host) {
        try {
          set({ lastError: null });
          return await deps.client.hostingDeviceStart(kind, host);
        } catch (e) {
          set({ lastError: describeError(e) });
          return null;
        }
      },

      async hostingDeviceFinish(kind, host, codes) {
        try {
          const a = await deps.client.hostingDeviceFinish(kind, host, codes);
          await get().loadHostingAccounts();
          return a;
        } catch (e) {
          set({ lastError: describeError(e) });
          return null;
        }
      },

      async hostingRemove(id) {
        try {
          await deps.client.hostingRemove(id);
          await get().loadHostingAccounts();
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async hostingOauthGet() {
        try {
          return await deps.client.hostingOauth();
        } catch {
          return { githubClientId: null, gitlabClientId: null };
        }
      },

      async hostingOauthSet(config) {
        try {
          await deps.client.hostingOauthSet(config);
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async hostingRepos(accountId, page, search) {
        try {
          set({ lastError: null });
          return await deps.client.hostingRepos(accountId, page, search);
        } catch (e) {
          set({ lastError: describeError(e) });
          return null;
        }
      },

      async hostingUrls(kind, host) {
        try {
          return await deps.client.hostingUrls(kind, host);
        } catch {
          return null;
        }
      },

      async loadProfiles() {
        try {
          set({ profiles: await deps.client.profiles() });
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async saveProfiles(list) {
        try {
          set({ profiles: await deps.client.profilesSet(list), lastError: null });
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async sshKeys() {
        try {
          return await deps.client.sshKeys();
        } catch (e) {
          set({ lastError: describeError(e) });
          return [];
        }
      },

      async sshKeygen(name, comment, passphrase) {
        try {
          const k = await deps.client.sshKeygen(name, comment, passphrase);
          set({ lastError: null });
          return k;
        } catch (e) {
          set({ lastError: describeError(e) });
          return null;
        }
      },

      async openUrl(url) {
        try {
          await deps.client.openUrl(url);
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async openExternal(kind, path) {
        const key = externalKey(kind, path);
        if (get().openingExternal.includes(key)) {
          return false;
        }
        set({ openingExternal: [...get().openingExternal, key], lastError: null });
        try {
          await deps.client.openExternal(kind, path);
          return true;
        } catch (e) {
          set({ lastError: describeError(e) });
          return false;
        } finally {
          set({ openingExternal: get().openingExternal.filter((k) => k !== key) });
        }
      },

      async externalAppsGet() {
        try {
          return await deps.client.externalAppsGet();
        } catch {
          return { editor: '', editorCustom: '', terminal: '', terminalCustom: '' };
        }
      },

      async externalAppsSet(apps) {
        set({ lastError: null });
        try {
          await deps.client.externalAppsSet(apps);
        } catch (e) {
          set({ lastError: describeError(e) });
          throw e;
        }
      },

      async autoFetchGet() {
        try {
          return await deps.client.autoFetchGet();
        } catch {
          return DEFAULT_AUTO_FETCH_MINUTES;
        }
      },

      async autoFetchSet(minutes) {
        set({ lastError: null });
        try {
          await deps.client.autoFetchSet(minutes);
        } catch (e) {
          set({ lastError: describeError(e) });
          throw e;
        }
      },

      async bootstrap() {
        notifyHub.setHandler((n) => get().notice(n));
        applyTheme(resolveTheme(get().theme, readSystemDark()));
        try {
          const info = await deps.client.gitVersion();
          set({ gitVersion: info.version, gitError: null });
        } catch (e) {
          set({ gitVersion: null, gitError: describeError(e) });
          return;
        }
        await get().loadRecent();
        void get().loadGroups();
        loadTemplates();
        // 콜드 스타트 탭 복원 → 시작 인자 → 두 번째 실행의 열기 요청
        let restored: string[] = [];
        try {
          restored = await deps.client.openTabsGet();
        } catch {
          // 저장소를 못 읽으면 빈 상태로 시작
        }
        // 하위 탭의 부모 경로: 탭을 열 때마다 저장이 지금 열린 탭으로 덮으므로 열기 전에 읽어 둔다
        const parentOf = readPref<Record<string, string>>(PREF_TAB_PARENTS, {});
        // 각 탭의 파일 탭: 저장해 둔 것을 먼저 읽어 두고, 다시 열지 못한 루트의 기록은 지운다. 파일 탭은 기다리지
        // 않고 뒤에서 연다 (시작을 늦추지 않게)
        const savedTabs = new Map(restored.map((root) => [root, readSavedEditorTabs(root)]));
        restoringRoots = new Set(restored);
        try {
          await get().openPaths(restored, parentOf);
        } finally {
          restoringRoots = new Set();
        }
        const reopened = get().sessionOrder.flatMap((id) => {
          const meta = get().sessions[id];
          return meta && savedTabs.has(meta.path) ? [meta] : [];
        });
        retainSavedEditorTabs(reopened.map((meta) => meta.path));
        for (const meta of reopened)
          void restoreTabsOf(meta.id, meta.path, savedTabs.get(meta.path) ?? null);
        try {
          const startup = await deps.client.takeStartupPaths();
          await get().openPaths(startup);
        } catch {
          // 무시
        }
        // 터미널 도구 창이 열린 채로 끝났으면 셸을 하나 띄운다 (탭을 복원한 뒤라 cwd 가 활성 탭 경로다)
        if (get().dock.tool === 'terminal' && get().terminals.length === 0) {
          get().openTerminal();
        }
        deps.client
          .subscribeAppEvents((event) => {
            if (event.type === 'openRequested') {
              void get().openPaths(event.paths);
            } else if (event.type === 'credentialRequested') {
              enqueueCredential({
                reqId: event.reqId,
                kind: event.kind,
                target: event.target,
                prompt: event.prompt,
                receivedAt: Date.now(),
              });
            }
          })
          .catch(() => {});
      },

      /** 기존 작업을 유지하고 임시 시작 화면을 보여준다. */
      showHome() {
        if (get().homeVisible) return;
        navigationVersion++;
        set({
          homeVisible: true,
          homeReturnSessionId: get().activeSessionId,
          activeSessionId: null,
        });
      },

      /** 직전 작업이 닫혔으면 남아 있는 마지막 탭으로 복귀한다. */
      returnToWorkspace() {
        const state = get();
        const id = state.homeReturnSessionId;
        const target = id !== null && state.sessions[id] ? id : state.sessionOrder.at(-1);
        if (target !== undefined) get().setActiveSession(target);
      },

      async openRepository() {
        if (directoryPicking || get().isOpening) return;
        directoryPicking = true;
        const version = navigationVersion;
        set({ isOpening: true, lastError: null });
        try {
          const path = await deps.pickDirectory(S.toolbar.openRepo);
          if (path)
            await get().openRepositoryAt(path, null, {
              activate: () => version === navigationVersion,
            });
        } catch (error) {
          set({ lastError: describeError(error) });
        } finally {
          directoryPicking = false;
          set({ isOpening: false });
        }
      },

      async openRepositoryAt(path, parent = null, options) {
        const version = navigationVersion;
        const activate = () => version === navigationVersion && options?.activate() !== false;
        set({ isOpening: true, lastError: null });
        const { onEvent, flush } = bufferedEvents();
        try {
          const opened = await deps.client.openRepo(path, onEvent);
          const id = opened.session;
          // 화면만 재연결된 경우 코어에 남아 있는 필터를 새 스토어에도 복원한다.
          const initialGraphQuery =
            opened.alreadyOpen && !getSessionStore(id)
              ? await deps.client.graphQuery(id)
              : undefined;
          if (opened.alreadyOpen && get().sessions[id]) {
            if (activate()) {
              set({ activeSessionId: id, homeVisible: false, homeReturnSessionId: null });
            }
            flush();
            return id;
          }
          const hidden = getSessionStore(id);
          if (hidden) {
            // 폴더 탭이 연 숨은 세션이 탭으로 올라왔다 (W13 승격, `opened.promoted`): 스토어를 새로 만들지 않고 같은
            // 스토어를 전체 프로필로 올린다. 이 채널의 이벤트(그래프 로드)는 세션 id 로 그 스토어에 간다. 코어가
            // 폴더들의 잡음을 지웠으므로 장부 항목은 빌림이 된다 (탭을 닫으면 지운다)
            hidden.getState().promote();
            set({ repoSessions: asBorrowed(get().repoSessions, id) });
          } else {
            const cache = new GraphRangeCache(tauriGraphSource(deps.client, id));
            registerSession(id, {
              cache,
              store: createSessionStore(opened, deps.client, cache, {
                ...sessionRevealHooks(get, id),
                initialGraphQuery,
              }),
            });
          }
          const wsStore = createRepoWorkspace(id, get);
          registerWorkspace(id, wsStore);
          addTab(
            {
              id,
              kind: 'repo',
              path: opened.info.workTree,
              name: repoNameOf(opened.info.workTree),
              parent,
            },
            activate(),
          );
          // 탭을 더하면 세션 문서가 파생된다. 승격한 세션에 폴더에서 연 문서가 있으면 그것을 보인다 — 옛 화면은 그 세션의
          // 마지막 열기(diff·충돌)를 보였다. 충돌을 열면 diff 슬롯이 비므로 둘 다 있으면 diff 가 나중에 연 것이다
          const opening = wsStore.getState().sessionDocs[0];
          if (opening) {
            wsStore.getState().revealDoc(opening.id);
          }
          flush();
          void get().loadRecent();
          // 보관 기간이 지난 백업 ref·폐기 백업을 조용히 정리한다 (#18·#26). 코어가 작업 트리마다 하루 한 번만 돌고,
          // 탭 열기를 기다리게 하지 않으며 실패해도 알리지 않는다
          void deps.client.pruneBackupsDaily(id).catch(() => {});
          return id;
        } catch (e) {
          const err = toIpcError(e);
          if (err.kind === 'multiRepoFolder') {
            set({ isOpening: false });
            if (activate()) {
              await get().openFolderAt(err.path, { activate });
            }
            return null;
          }
          set({ lastError: describeError(e) });
          return null;
        } finally {
          set({ isOpening: false });
        }
      },

      openFolderAt(path, options) {
        return openFolderTab((onEvent) => deps.client.openFolder(path, onEvent), options);
      },

      async openGroupAt(id, options) {
        await openFolderTab((onEvent) => deps.client.openGroup(id, onEvent), options);
        // 마지막 연 시각이 바뀌었다 (홈의 그룹 묶음 순서)
        void get().loadGroups();
      },

      async openPaths(paths, parentOf = {}) {
        for (const p of paths) {
          // 저장한 탭 목록의 그룹 키(`mgit-group:<id>`)는 그룹으로, 나머지는 경로로 연다
          const group = groupIdOf(p);
          if (group !== null) {
            await get().openGroupAt(group);
          } else {
            // 저장 순서상 부모가 먼저 열린다. 부모 경로의 탭이 없으면(열지 못했으면) 독립 탭으로 연다
            const parentPath = parentOf[p];
            const { sessions, sessionOrder } = get();
            const parent =
              typeof parentPath === 'string'
                ? (sessionOrder.find((id) => sessions[id]?.path === parentPath) ?? null)
                : null;
            await get().openRepositoryAt(p, parent);
          }
        }
      },

      async loadGroups() {
        try {
          set({ groups: await deps.client.groupsList() });
        } catch {
          // 그룹 목록은 없어도 된다 (홈에 빈 묶음)
        }
      },

      setGroupDialog(request) {
        set({ groupDialog: request, lastError: null });
      },

      async createGroup(name, paths) {
        try {
          const created = await deps.client.groupCreate(name, paths);
          await get().loadGroups();
          await get().openGroupAt(created.id);
          return true;
        } catch (e) {
          set({ lastError: describeError(e) });
          return false;
        }
      },

      async updateGroup(id, update) {
        // 열린 그룹은 탭을 연 채로 고친다 (M4): 빠지는 멤버의 파일 탭은 먼저 초안 확인 뒤 닫고(취소하면 고치지 않는다),
        // 별칭이 바뀌는 멤버의 문서는 고치는 동안 멈춘다. 고치기 전 멤버는 목록에서, 아직 못 읽었으면 열린 탭의 모습에서 본다
        const open = openGroupSession(id);
        const before =
          get().groups.find((g) => g.id === id)?.members ??
          (open === null ? undefined : getFolderStore(open)?.getState().group?.members) ??
          [];
        const changes = memberChanges(before, update.members);
        const edit = open === null ? null : await prepareOpenGroupEdit(open, changes);
        if (open !== null && edit === null) return false;
        let ok = true;
        try {
          await deps.client.groupUpdate(id, update);
        } catch (e) {
          ok = false;
          get().notice({ kind: 'error', title: S.group.updateFailed, message: describeError(e) });
        }
        if (edit) finishOpenGroupEdit(edit, ok);
        // 저장한 기록(편집기 탭 복원·최근 파일)의 경로도 새 별칭으로 옮긴다 (닫힌 그룹이어도)
        if (ok) moveRootPrefPaths(groupKey(id), groupPathMove(changes));
        await get().loadGroups();
        return ok;
      },

      async deleteGroup(id) {
        const open = openGroupSession(id);
        if (open !== null && !(await closeTabAndWait(open))) {
          return false;
        }
        try {
          await deps.client.groupDelete(id);
        } catch (e) {
          set({ lastError: describeError(e) });
          return false;
        } finally {
          await get().loadGroups();
        }
        // 지운 그룹 키의 화면 기록(탭 복원·최근 파일·열 너비·즐겨찾기)도 지운다. 폴더 설정은 코어가 지웠다
        forgetRootPrefs(groupKey(id));
        return true;
      },

      withRepoSession(folder, repoPath, run) {
        return serial(folder, async () => {
          const ws = getWorkspaceStore(folder)?.getState();
          if (get().sessions[folder]?.kind !== 'folder' || !ws) {
            return false;
          }
          // 범위 세션이 바쁜 동안에는 다른 저장소로 옮기지 않는다 (그 세션의 대화상자·작업이 화면에서 사라진다)
          if (
            ws.activeRepo !== null &&
            ws.activeRepo !== repoPath &&
            folderActiveRepoLocked(folder)
          ) {
            get().notice({
              kind: 'info',
              title: S.repoSession.busyElsewhere(repoLabel(folder, ws.activeRepo)),
            });
            return false;
          }
          // 요청한 저장소가 활성 저장소가 된다: 상태 바에 대상이 보이고 범위 세션이 그 세션이 된다
          ws.setActiveRepo(repoPath);
          const id = await ensureRepoSession(folder, repoPath);
          const st = id === null ? undefined : getSessionStore(id)?.getState();
          if (!st) {
            return false;
          }
          run(st);
          return true;
        });
      },

      closeRepoDiff(tab, repoPath) {
        repoSessionState(tab, repoPath)?.closeFile();
      },

      openRepoConflict(folder, repoPath, path) {
        if (get().conflictLeave !== null) return Promise.resolve(false);
        return get().withRepoSession(folder, repoPath, (st) => {
          if (get().conflictLeave !== null) return;
          // 같은 저장소의 다른 충돌 파일로 바꾸면 지금 파일의 초안이 화면에서 사라진다 (초안은 남는다) → 먼저 확인
          if (st.conflict !== null && st.conflict.path !== path && openConflictDraft(st) !== null) {
            set({
              conflictLeave: {
                folder,
                repoPath,
                repoName: folderRepoName(folder, repoPath),
                path: st.conflict.path,
                next: path,
              },
            });
            return;
          }
          openConflictIn(folder, repoPath, st, path);
        });
      },

      closeRepoConflict(tab, repoPath) {
        if (get().conflictLeave !== null) return Promise.resolve(false);
        const st = repoSessionState(tab, repoPath);
        // 열린 충돌이 없으면(저장소 탭의 "여는 중" 문서 포함 — 옛 닫기도 읽기를 멈추지 않았다, W20 ③) 할 일이 없다
        if (!st?.conflict) {
          return;
        }
        const path = st.conflict.path;
        if (openConflictDraft(st) !== null) {
          return new Promise<boolean>((resolve) => {
            conflictCloseResolve = resolve;
            set({
              conflictLeave: {
                folder: tab,
                repoPath,
                repoName: tabRepoName(tab, repoPath),
                path,
                next: null,
              },
            });
          });
        }
        st.closeConflict();
        return Promise.resolve(true);
      },

      confirmConflictLeave(discard) {
        const pending = get().conflictLeave;
        set({ conflictLeave: null });
        const st = pending ? repoSessionState(pending.folder, pending.repoPath) : undefined;
        if (!pending || !st) {
          conflictCloseResolve?.(false);
          conflictCloseResolve = null;
          return;
        }
        if (discard) {
          st.setConflictDraft(pending.path, null);
        }
        if (pending.next === null) {
          st.closeConflict();
        } else {
          openConflictIn(pending.folder, pending.repoPath, st, pending.next);
        }
        conflictCloseResolve?.(true);
        conflictCloseResolve = null;
      },

      cancelConflictLeave() {
        set({ conflictLeave: null });
        conflictCloseResolve?.(false);
        conflictCloseResolve = null;
      },

      async closeSession(id) {
        const { sessions, sessionOrder, activeSessionId } = get();
        const meta = sessions[id];
        if (!meta) {
          return;
        }
        const closingIds = [id, ...sessionOrder.filter((child) => sessions[child]?.parent === id)];
        const approved = approvedCloseIds.has(id);
        if (!approved && !(await guardFileEditorClose(closingIds.map((session) => ({ session })))))
          return;
        // 폴더 탭을 닫으면 거기서 연 하위 저장소 탭도 닫는다
        if (meta.kind === 'folder' && !approved) {
          for (const child of sessionOrder) {
            if (sessions[child]?.parent === id) {
              await get().closeSession(child);
            }
          }
        }
        const current = get();
        const rest = { ...current.sessions };
        delete rest[id];
        // 중간 부모가 닫혀 세트에서 떨어진 하위 탭이 남은 세트를 가르지 않게 다시 묶는다
        const order = groupTabOrder(
          current.sessionOrder.filter((s) => s !== id),
          rest,
        );
        // 장부 (W13): 폴더 탭이면 그 폴더의 장부를 비운다(코어의 폴더 닫기가 잡음을 거둔다). 저장소 탭이면 그 세션을
        // 가리키던 폴더 장부 항목을 지운다 — 탭이 닫으면 세션이 닫히므로, 다음에 필요하면 새로 연다
        const { [id]: ledger, ...otherLedgers } = current.repoSessions;
        const held = Object.values(ledger ?? {}).map((e) => e.session);
        set({
          sessions: rest,
          sessionOrder: order,
          activeSessionId:
            activeSessionId === id || current.activeSessionId === id
              ? (order[order.length - 1] ?? null)
              : current.activeSessionId,
          repoSessions:
            meta.kind === 'folder' ? otherLedgers : withoutSession(current.repoSessions, id),
        });
        if (!approved) persistTabs();
        // 사용자가 탭을 닫았으니 다음에 다시 켜도 그 파일 탭을 되살리지 않는다 (앱 종료는 이 길을 지나지 않는다)
        stopEditorWatch(id);
        writeSavedEditorTabs(meta.path, null);
        disposeWorkspace(id);
        fileEditors.releaseSession(id);
        folderRepoWatches.get(id)?.();
        folderRepoWatches.delete(id);
        for (const session of held) {
          disposeIfUnused(session);
        }
        try {
          if (meta.kind === 'folder') {
            disposeFolder(id);
            await deps.client.closeFolder(id);
          } else {
            disposeSession(id);
            await deps.client.closeRepo(id);
          }
        } catch {
          // 이미 닫힌 세션이면 무시
        }
      },

      requestCloseSession(id) {
        return get().requestCloseTabs(id, 'this');
      },

      async requestCloseTabs(id, mode) {
        const state = get();
        if (state.closeTabsRunning) return;
        const requested = sessionCloseTargets(state.sessionOrder, state.sessions, id, mode);
        if (!requested.length) return;
        set({ closeTabsRunning: true });
        const plan = inspectClosePlan({
          target: id,
          mode,
          requested,
          identities: { ...state.sessions },
          targets: [],
          protectedIds: [],
          risks: [],
          signature: '',
        });
        if (plan.protectedIds.length)
          get().notice({
            kind: 'info',
            title: S.toolbar.closeTabsBusy,
            message: plan.protectedIds.map((key) => state.sessions[key]?.name ?? '').join(', '),
          });
        if (plan.risks.length) publishClosePlan(plan);
        else await finishClosePlan(plan);
      },

      async confirmCloseSession() {
        const plan = get().closeTabsPending;
        if (plan) {
          await finishClosePlan(plan);
          return;
        }
        const pending = get().closeConfirm ?? get().folderCloseConfirm;
        set({ closeConfirm: null, folderCloseConfirm: null });
        if (pending) await get().closeSession(pending.id);
      },

      cancelCloseSession() {
        set({
          closeConfirm: null,
          folderCloseConfirm: null,
          closeTabsConfirm: null,
          closeTabsPending: null,
          closeTabsRunning: false,
        });
      },

      setActiveSession(id) {
        if (get().sessions[id]) {
          navigationVersion++;
          set({ activeSessionId: id, homeVisible: false, homeReturnSessionId: null });
        }
      },

      setTheme(pref) {
        saveThemePreference(pref);
        applyTheme(resolveTheme(pref, readSystemDark()));
        set({ theme: pref });
      },

      async initLanguage(timeoutMs) {
        await applyLanguagePreference(get().language, timeoutMs);
      },

      async setLanguage(pref) {
        saveLanguagePreference(pref);
        await applyLanguagePreference(pref);
        // 시작할 때 한 번 받아 두는 Rust 문구 데이터는 새 언어로 다시 받는다 (이미 화면에 낸 오류·결과는 그대로 둔다)
        loadTemplates();
      },

      clearError() {
        set({ lastError: null });
      },

      toggleDock(tool, gitTab) {
        setDock(dockToggled(get().dock, tool, gitTab));
        if (get().dock.tool === 'terminal' && get().terminals.length === 0) {
          get().openTerminal();
        }
      },

      hideDock() {
        setDock(dockHidden(get().dock));
      },

      toggleDockMaximized() {
        setDock(dockMaximized(get().dock, !get().dock.maximized));
      },

      setDockMaximized(on) {
        setDock(dockMaximized(get().dock, on));
      },

      setGitDockTab(tab) {
        setDock({ ...get().dock, gitTab: tab });
      },

      setLeftTool(tool) {
        if (get().leftTool === tool) {
          return;
        }
        set({ leftTool: tool });
        writePref(PREF_LEFT_TOOL, { tool });
      },

      toggleLeftTool(tool) {
        const shown = effectiveLeftTool(get().leftTool, prToolAvailable(get()));
        get().setLeftTool(shown === tool ? null : tool);
      },

      setCommitTab(tab) {
        if (get().commitTab !== tab) {
          set({ commitTab: tab });
        }
      },

      revealCommitChanges() {
        get().setCommitTab('changes');
        get().setLeftTool('commit');
      },

      openTerminal(cwd, title, initialInput) {
        const st = get();
        // 위치를 주지 않으면 활성 탭 공간의 디렉터리(저장소 작업 트리·폴더 루트). 디렉터리가 없는 공간(가상 그룹)은 그 탭의
        // 활성 저장소, 그것도 없으면 홈
        const active = st.activeSessionId !== null ? st.sessions[st.activeSessionId] : undefined;
        const activeRepo = active ? getWorkspaceStore(active.id)?.getState().activeRepo : null;
        const dir =
          cwd ?? (active ? tabSpace(active.id, active.path)?.dir : undefined) ?? activeRepo ?? '~';
        const id = ++terminalSeq;
        set({
          terminals: [
            ...st.terminals,
            { id, cwd: dir, title: title ?? '', initialInput: initialInput ?? null },
          ],
          activeTerminal: id,
        });
        setDock(dockShown(get().dock, 'terminal'));
      },

      closeTerminal(id) {
        const rest = get().terminals.filter((t) => t.id !== id);
        set({
          terminals: rest,
          activeTerminal:
            get().activeTerminal === id
              ? (rest[rest.length - 1]?.id ?? null)
              : get().activeTerminal,
        });
        if (rest.length === 0 && get().dock.tool === 'terminal') {
          setDock(dockHidden(get().dock));
        }
      },

      setActiveTerminal(id) {
        set({ activeTerminal: id });
      },

      markTerminalExited(id, code) {
        set({
          terminals: get().terminals.map((t) => (t.id === id ? { ...t, exitCode: code } : t)),
        });
      },

      clearTerminalInput(id) {
        if (!get().terminals.some((t) => t.id === id && t.initialInput !== null)) {
          return;
        }
        set({
          terminals: get().terminals.map((t) => (t.id === id ? { ...t, initialInput: null } : t)),
        });
      },

      async refreshActive() {
        const id = get().activeSessionId;
        if (id === null) {
          return;
        }
        // 사용자가 고른 새로고침이다: 편집기의 Blame·HEAD 원문도 다시 묻는다 (G1)
        markExplicitRefresh(id);
        // 저장소 탭은 상태와 함께 Project 도구 창의 펼친 파일 트리도 다시 읽는다 (W21). 트리를 아직 열지 않았으면 읽지 않는다
        const session = getSessionStore(id)?.getState();
        await Promise.all([session?.refresh(), session?.reloadFiles()]);
        // 폴더 탭은 요약과 함께 펼친 파일 트리도 다시 읽는다 (창 포커스 재조회와 겹치면 트리가 끝난 뒤 한 번 더 돈다)
        const folder = getFolderStore(id)?.getState();
        await Promise.all([folder?.refresh(), folder?.fileTree.getState().reload()]);
      },

      async loadRecent() {
        try {
          set({ recent: await deps.client.recentList() });
        } catch {
          // 최근 목록은 없어도 된다
        }
      },

      async pinRecent(path, pinned) {
        try {
          await deps.client.recentPin(path, pinned);
          await get().loadRecent();
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async removeRecent(path) {
        try {
          await deps.client.recentRemove(path);
          await get().loadRecent();
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async scanFolder() {
        const root = await deps.pickDirectory(S.home.scanTitle);
        if (!root) {
          return;
        }
        try {
          await deps.client.scanRepos(root);
          await get().loadRecent();
        } catch (e) {
          set({ lastError: describeError(e) });
        }
      },

      async cloneRepository(request) {
        if (get().cloneOp && !get().cloneOp?.done) {
          return false;
        }
        set({ lastError: null });
        try {
          const dest = await deps.client.cloneRepo(request, trackCloneOp);
          set({ cloneOp: null });
          await get().openRepositoryAt(dest);
          return true;
        } catch (e) {
          set({ lastError: describeError(e), cloneOp: null });
          return false;
        }
      },

      async cloneRepositories(request) {
        if (get().cloneOp && !get().cloneOp?.done) {
          return null;
        }
        set({ lastError: null });
        const startedAt = Date.now();
        let result: BatchResult;
        try {
          result = await deps.client.cloneMany(request, trackCloneOp);
          set({ cloneOp: null });
        } catch (e) {
          set({ lastError: describeError(e), cloneOp: null });
          return null;
        }
        // 상위 폴더를 폴더 탭으로 연다. 이미 열려 있던 탭이면 새 저장소가 보이게 다시 스캔한다. 그 폴더의 작업 기록에 남긴다
        const opened = new Set(get().sessionOrder);
        await get().openFolderAt(request.parent);
        const id = get().activeSessionId;
        const folder = id === null ? undefined : getFolderStore(id);
        if (folder) {
          if (opened.has(id as SessionId)) {
            await folder.getState().rescan();
          }
          folder.getState().recordClone(result, request, startedAt);
        }
        return result;
      },

      async cancelClone() {
        const op = get().cloneOp;
        if (op && !op.done) {
          await deps.client.cancelOperation(op.id).catch(() => false);
        }
      },

      async initRepository(path, defaultBranch, template) {
        set({ lastError: null });
        try {
          const created = await deps.client.initRepo(path, defaultBranch, template);
          await get().openRepositoryAt(created);
          return true;
        } catch (e) {
          set({ lastError: describeError(e) });
          return false;
        }
      },
    };
  });
  mirrorSessionDocs(store);
  watchCommitReveal(store);
  return store;
}

export type AppStoreHook = ReturnType<typeof createAppStore>;
