import { S } from '@mgit/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import styles from './App.module.css';
import {
  type Action,
  type ActionApp,
  type ActionSession,
  buildActions,
  openTagsDoc,
  showCommitChanges,
  type TagsDocRequestInput,
} from './actions';
import { captureCommandTarget } from './command-registry';
import { ActionErrorBar } from './components/ActionErrorBar';
import { CommandContext } from './components/command-context';
import { Toasts } from './components/Toasts';
import { useDialogs } from './components/use-dialogs';
import { CloseSessionDialog, CredentialDialog, SettingsDialog } from './features/app/AppDialogs';
import { RepoSettingsDialog } from './features/app/RepoSettingsDialog';
import { BranchQuickSwitch } from './features/branch/BranchQuickSwitch';
import { HintDialogs } from './features/branch/HintDialogs';
import {
  ConflictRulesDialog,
  RenameConflictDialog,
  ReviewDialog,
} from './features/conflict/AssistDialogs';
import { BlameDialog } from './features/history/BlameDialog';
import { CompareDialog } from './features/history/CompareDialog';
import { FileHistoryDialog } from './features/history/FileHistoryDialog';
import { columnsFlow, compareFlow } from './features/history/flows';
import { HomeScreen } from './features/home/HomeScreen';
import { cloneFlow, createBranchFlow, initFlow } from './features/home/repo-flows';
import { AccountsDialog } from './features/hosting/AccountsDialog';
import { ProfilesDialog } from './features/hosting/ProfilesDialog';
import { RemoteReposDialog } from './features/hosting/RemoteReposDialog';
import { SshKeysDialog } from './features/hosting/SshKeysDialog';
import { CommandPalette } from './features/palette/CommandPalette';
import { MergePreviewDialog } from './features/preview/MergePreviewDialog';
import { RebasePreviewDialog } from './features/preview/RebasePreviewDialog';
import { RebasePlanDialog } from './features/rebase/RebasePlanDialog';
import { FileBackupsDialog } from './features/safety/FileBackupsDialog';
import { ReflogDialog } from './features/safety/ReflogDialog';
import {
  ConflictLeaveDialog,
  FolderCloseDialog,
  FolderHints,
} from './features/workspace/FolderDialogs';
import { FolderOpBand } from './features/workspace/FolderOpBand';
import { FolderWorkspace } from './features/workspace/FolderWorkspace';
import { RepoOpBand } from './features/workspace/RepoOpBand';
import { RepoWorkspace } from './features/workspace/RepoWorkspace';
import { editorKeyDoc, handleGlobalKey } from './global-keys';
import { BottomDock } from './layout/BottomDock';
import { StatusBar } from './layout/StatusBar';
import { Toolbar } from './layout/Toolbar';
import { ToolStripe } from './layout/ToolStripe';
import {
  getSessionStore,
  getWorkspaceStore,
  repoNameOf,
  useActivePrKind,
  useActiveTab,
  useAppStore,
  useHasSession,
  useIsRepoTab,
  useSession,
  useShownLeftTool,
  useWorkspace,
} from './store';
import { type AppStore, shownDock } from './store/app-store';
import type { SessionState } from './store/session-store';
import { allDocs } from './store/workspace-store';

/** 열기 명령은 기존 탭을 보존하는 시작 화면으로 이동한다. */
async function showHomeAction(): Promise<void> {
  useAppStore.getState().showHome();
}

/** 동작이 읽는 앱 상태만 고른다 (토스트 등 무관한 변경에 앱 전체가 다시 그려지지 않게) */
function pickApp(s: AppStore): ActionApp {
  return {
    activeSessionId: s.activeSessionId,
    sessionOrder: s.sessionOrder,
    isOpening: s.isOpening,
    theme: s.theme,
    shortcutOverrides: s.shortcutOverrides,
    templates: s.templates,
    dock: s.dock,
    pickDirectory: s.pickDirectory,
    cloneRepository: s.cloneRepository,
    initRepository: s.initRepository,
    openRepository: showHomeAction,
    requestCloseSession: s.requestCloseSession,
    setActiveSession: s.setActiveSession,
    refreshActive: s.refreshActive,
    toggleDock: s.toggleDock,
    hideDock: s.hideDock,
    toggleDockMaximized: s.toggleDockMaximized,
    setDockMaximized: s.setDockMaximized,
    setLeftTool: s.setLeftTool,
    setAppDialog: s.setAppDialog,
    setShortcutsOpen: s.setShortcutsOpen,
    openExternal: s.openExternal,
    setSettingsOpen: s.setSettingsOpen,
    setTheme: s.setTheme,
  };
}

/** 동작이 읽는 세션 상태만 고른다 (커밋 메시지 입력 등에 앱 전체가 다시 그려지지 않게) */
function pickSession(s: SessionState): ActionSession {
  return {
    busy: s.busy,
    op: s.op,
    refs: s.refs,
    path: s.path,
    status: s.status,
    undoState: s.undoState,
    fetch: s.fetch,
    pull: s.pull,
    push: s.push,
    setSearchOpen: s.setSearchOpen,
    openRepoSettings: s.openRepoSettings,
    stashPush: s.stashPush,
    undo: s.undo,
    redo: s.redo,
    setReflogOpen: s.setReflogOpen,
    openFileBackups: s.openFileBackups,
    remoteProject: s.remoteProject,
    checkRemoteTags: s.checkRemoteTags,
  };
}

/**
 * 동작 레지스트리 (UX-02·03): 팔레트·단축키가 같은 목록을 쓴다. 고른 상태가 바뀔 때마다 다시 만든다.
 * 세션 동작은 저장소 탭일 때만 켠다 — 폴더 탭에서 숨은 세션이 범위 세션이어도 그 저장소에 대고 동작하지 않는다 (W13)
 */
function useActions(setQuickSwitch: (open: boolean) => void): {
  actions: Action[];
  dialogElement: ReactNode;
} {
  const app = useAppStore(useShallow(pickApp));
  const session = useSession(pickSession);
  const isRepoTab = useIsRepoTab();
  const tabKind = useActiveTab()?.kind ?? null;
  const dialogs = useDialogs();
  const activeId = useAppStore((s) => s.activeSessionId);
  const openQuickSwitch = useCallback(() => setQuickSwitch(true), [setQuickSwitch]);
  const startClone = useCallback(
    () =>
      void cloneFlow(dialogs, {
        pickDirectory: app.pickDirectory,
        cloneRepository: app.cloneRepository,
      }),
    [dialogs, app.pickDirectory, app.cloneRepository],
  );
  const startInit = useCallback(
    () =>
      void initFlow(dialogs, {
        pickDirectory: app.pickDirectory,
        templates: app.templates,
        initRepository: app.initRepository,
      }),
    [dialogs, app.pickDirectory, app.templates, app.initRepository],
  );
  const promptBranch = useCallback(() => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void createBranchFlow(dialogs, store.getState().createBranch);
    }
  }, [dialogs, activeId]);
  const promptCompare = useCallback(() => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void compareFlow(dialogs, store.getState());
    }
  }, [dialogs, activeId]);
  const promptColumns = useCallback(() => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void columnsFlow(dialogs, store.getState());
    }
  }, [dialogs, activeId]);
  /**
   * 에디터 공간의 활성 탭을 닫는다 (⌘W, 결정 7번 — 폴더 탭 W19, 저장소 탭 W21). 세션 문서의 닫기 규칙(초안 확인)은
   * `closeDoc` 의 몫이다
   */
  const closeEditorDoc = useCallback(() => {
    const ws = activeId === null ? undefined : getWorkspaceStore(activeId)?.getState();
    if (!ws || ws.activeDocId === null) {
      return false;
    }
    ws.closeDoc(ws.activeDocId);
    return true;
  }, [activeId]);
  /** 저장소 탭의 태그 문서를 연다 (팔레트 "tag 관리", C3a) */
  const openTagsDocAction = useCallback(
    (request?: TagsDocRequestInput) => {
      if (activeId !== null && session) {
        openTagsDoc(
          getWorkspaceStore(activeId)?.getState(),
          session.path,
          repoNameOf(session.path),
          request,
        );
      }
    },
    [activeId, session],
  );
  const actions = useMemo(
    () =>
      buildActions({
        app,
        session: isRepoTab ? session : null,
        tabKind,
        openQuickSwitch,
        openPalette: () => {
          captureCommandTarget();
          useAppStore.getState().setPaletteOpen(true);
        },
        prepareCommit: () => {
          showCommitChanges(useAppStore.getState());
          setTimeout(
            () => document.querySelector<HTMLElement>('[data-commit-message]')?.focus(),
            0,
          );
        },
        startClone,
        startInit,
        promptBranch,
        promptCompare,
        promptColumns,
        closeEditorDoc,
        openTagsDoc: isRepoTab ? openTagsDocAction : undefined,
      }),
    [
      app,
      session,
      isRepoTab,
      tabKind,
      openQuickSwitch,
      startClone,
      startInit,
      promptBranch,
      promptCompare,
      promptColumns,
      closeEditorDoc,
      openTagsDocAction,
    ],
  );
  return { actions, dialogElement: dialogs.element };
}

/**
 * 전역 단축키 (UX-03): 판단은 `handleGlobalKey` 가 한다. Esc 가 닫는 문서는 활성 탭 워크스페이스(에디터 공간)의 활성
 * 문서다 — 폴더 탭·저장소 탭이 같다 (W21). 세션 문서를 닫으면 워크스페이스가 그 세션 슬롯을 비운다(`closeSessionDoc` —
 * 충돌 초안이 있으면 확인). 폴더 탭은 숨은 세션이 범위 세션이어도 그 세션의 검색을 건드리지 않는다
 */
function useGlobalShortcuts(actions: Action[]): void {
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const isRepoTab = useIsRepoTab();
  const s = useSession((st) => ({
    searchOpen: st.search.open,
    setSearchOpen: st.setSearchOpen,
  }));
  const ws = useWorkspace((w) => ({
    doc: allDocs(w).find((d) => d.id === w.activeDocId),
    closeDoc: w.closeDoc,
  }));
  const searchOpen = isRepoTab && s.searchOpen;
  const activeDoc = editorKeyDoc(ws?.doc);
  const { setSearchOpen } = s;
  const docId = ws?.doc?.id ?? null;
  const closeDoc = ws?.closeDoc;
  useEffect(() => {
    /** 활성 문서를 닫는다 (세션 문서는 워크스페이스가 그 문서의 세션 슬롯을 비운다 — 범위 세션의 화면이 아니라) */
    const closeActiveDoc = () => {
      if (docId !== null) {
        closeDoc?.(docId);
      }
    };
    const onKeyDown = (e: KeyboardEvent) =>
      handleGlobalKey(e, {
        actions,
        openPalette: () => setPaletteOpen(true),
        searchOpen,
        closeSearch: () => setSearchOpen(false),
        activeDoc,
        closeActiveDoc,
        returnHome: () => {
          const app = useAppStore.getState();
          if (!app.homeVisible) return false;
          app.returnToWorkspace();
          return true;
        },
      });
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, setPaletteOpen, setSearchOpen, searchOpen, activeDoc, docId, closeDoc]);
}

/**
 * 왼쪽 도구 창 띠 (WS-05): 위 = Project·Commit·Pull Requests(같은 자리에 번갈아), 아래 = Git·터미널. 폴더 탭·저장소 탭
 * 모두 같은 띠다 (W21). Pull Requests 단추는 원격 프로젝트(GitHub/GitLab)가 있는 저장소 탭에만 있고 이름은 호스팅 종류를
 * 따른다 (W24, WS-17). 강조는 저장된 값이 아니라 지금 보이는 도구 창이다 (`useShownLeftTool`). 탭이 없으면(홈) 그리지
 * 않는다
 */
function StripePane() {
  const tabKind = useActiveTab()?.kind ?? null;
  const shownLeft = useShownLeftTool();
  const prKind = useActivePrKind();
  const dockTool = useAppStore((s) => shownDock(s).tool);
  const toggleLeftTool = useAppStore((s) => s.toggleLeftTool);
  const toggleDock = useAppStore((s) => s.toggleDock);
  if (tabKind === null) {
    return null;
  }
  return (
    <ToolStripe
      top={[
        {
          id: 'project',
          icon: 'project',
          label: S.project.title,
          active: shownLeft === 'project',
          onToggle: () => toggleLeftTool('project'),
        },
        {
          id: 'commit',
          icon: 'commit',
          label: S.commitTool.title,
          active: shownLeft === 'commit',
          onToggle: () => toggleLeftTool('commit'),
        },
        ...(prKind === null
          ? []
          : [
              {
                id: 'pullRequests',
                icon: 'pullRequest' as const,
                label: S.pr.title(prKind),
                active: shownLeft === 'pullRequests',
                onToggle: () => toggleLeftTool('pullRequests'),
              },
            ]),
      ]}
      bottom={[
        {
          id: 'git',
          icon: 'git',
          label: S.dock.git,
          active: dockTool === 'git',
          onToggle: () => toggleDock('git'),
        },
        {
          id: 'terminal',
          icon: 'terminal',
          label: S.terminal.title,
          active: dockTool === 'terminal',
          onToggle: () => toggleDock('terminal'),
        },
      ]}
    />
  );
}

/**
 * 위 영역: 탭이 없으면 시작 화면, 폴더 탭이면 폴더 워크스페이스, 저장소 탭이면 저장소 워크스페이스 (W21 — 같은 틀:
 * 왼쪽 도구 창 | 에디터 공간). 두 탭의 로그·상세는 아래 Git 도구 창의 로그 탭에 있다 (`BottomDock`)
 */
function CenterPane({ actions }: { actions: readonly Action[] }) {
  const activeKind = useActiveTab()?.kind ?? null;
  if (activeKind === null) {
    return <HomeScreen />;
  }
  if (activeKind === 'folder') {
    return <FolderWorkspace actions={actions} />;
  }
  return <RepoWorkspace actions={actions} />;
}

/**
 * 본문: 왼쪽 도구 창 띠 + 아래 도구 창 슬롯으로 감싼 화면. 띠는 슬롯의 바깥 왼쪽에 있어 위 영역과 아래 도구 창
 * 전체 높이에 걸친다. 슬롯은 탭 종류(저장소·폴더·없음)와 무관하게 여기서 한 번만 마운트한다 (WS-02) — 터미널 뷰가
 * 내려가지 않도록 띠가 있든 없든 슬롯의 자리는 바뀌지 않는다
 */
export function AppBody({ actions }: { actions: readonly Action[] }) {
  return (
    <CommandContext.Provider value={actions}>
      <div className={styles.body}>
        <StripePane />
        <div className={styles.main}>
          <BottomDock>
            <CenterPane actions={actions} />
          </BottomDock>
        </div>
      </div>
    </CommandContext.Provider>
  );
}

/**
 * 앱 셸: 툴바 / 작업 진행 띠(폴더 탭 = 저장소마다 한 줄, 저장소 탭 = 그 탭의 작업·격리 병합 — W21) / 본문 / 상태 바 +
 * 전역 대화상자·팔레트. 세션 대화상자는 둘로 가른다 (W13):
 * blame·파일 히스토리는 범위 세션이 있으면(폴더 탭의 숨은 세션 포함) 마운트하고, 나머지는 저장소 탭일 때만 마운트한다.
 * 힌트는 저장소 탭이면 그 탭의 세션 것(`HintDialogs`), 폴더 탭이면 장부 세션들 중 폴더 탭에서 켠 종류(`FolderHints`, W15).
 * 폴더 탭에 대화상자를 더하면 `repo-sessions.ts` 의 `sessionDialogOpen` 에도 더한다
 */
export function App() {
  const [quickSwitch, setQuickSwitch] = useState(false);
  const { actions, dialogElement } = useActions(setQuickSwitch);
  useGlobalShortcuts(actions);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const hasSession = useHasSession();
  const isRepoTab = useIsRepoTab();
  const isFolderTab = useActiveTab()?.kind === 'folder';
  return (
    <div className={styles.app}>
      <Toolbar />
      {isFolderTab ? <FolderOpBand /> : null}
      {isRepoTab ? <RepoOpBand /> : null}
      <ActionErrorBar />
      <AppBody actions={actions} />
      <StatusBar />
      {hasSession ? <BlameDialog /> : null}
      {hasSession ? <FileHistoryDialog /> : null}
      {isRepoTab ? <HintDialogs /> : null}
      {isFolderTab ? <FolderHints /> : null}
      {isRepoTab ? <ReflogDialog /> : null}
      {isRepoTab ? <FileBackupsDialog /> : null}
      {isRepoTab ? <RebasePlanDialog /> : null}
      {isRepoTab ? <CompareDialog /> : null}
      {isRepoTab ? <MergePreviewDialog /> : null}
      {isRepoTab ? <RebasePreviewDialog /> : null}
      {isRepoTab ? <RenameConflictDialog /> : null}
      {isRepoTab ? <ConflictRulesDialog /> : null}
      {isRepoTab ? <ReviewDialog /> : null}
      {isRepoTab ? <RepoSettingsDialog /> : null}
      <AccountsDialog />
      <ProfilesDialog />
      <SshKeysDialog />
      <RemoteReposDialog />
      <Toasts />
      {quickSwitch && isRepoTab ? (
        <BranchQuickSwitch onClose={() => setQuickSwitch(false)} />
      ) : null}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} actions={actions} />
      <CredentialDialog />
      <CloseSessionDialog />
      <FolderCloseDialog />
      <ConflictLeaveDialog />
      <SettingsDialog actions={actions} />
      {dialogElement}
    </div>
  );
}
