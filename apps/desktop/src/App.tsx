import { RepositoryPaletteProvider, repositoryRosterKey, repositorySlotCount, S } from '@mgit/ui';
import {
  type MutableRefObject,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/shallow';
import styles from './App.module.css';
import {
  type Action,
  type ActionApp,
  actionSessionOf,
  buildActions,
  developerActions,
  type FolderActions,
  groupOpenActions,
  openTagsDoc,
  showCommitChanges,
  type TagsDocRequestInput,
} from './actions';
import { captureCommandTarget } from './command-registry';
import { ActionErrorBar } from './components/ActionErrorBar';
import { CommandContext, type CommandSource } from './components/command-context';
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
import { useBatchReport } from './features/folder/batch-report';
import { useFolderBatchFlows } from './features/folder/FolderBatchBar';
import { GroupDialog } from './features/group/GroupDialog';
import { BlameDialog } from './features/history/BlameDialog';
import { ComparisonLauncher } from './features/history/ComparisonDoc';
import { FileHistoryDialog } from './features/history/FileHistoryDialog';
import { columnsFlow, compareFlow } from './features/history/flows';
import { batchCloneFlow } from './features/home/batch-clone';
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
import { WorkspaceSearch } from './features/search/WorkspaceSearch';
import { commandSourceKey, commandSourceOf } from './features/workspace/editor-hints';
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
import { runtimeProfile } from './runtime';
import {
  getSessionStore,
  getWorkspaceStore,
  repoNameOf,
  useActivePrKind,
  useActiveTab,
  useAppStore,
  useFolder,
  useIsRepoTab,
  useSessionOf,
  useShownLeftTool,
  useWorkspace,
} from './store';
import { type AppStore, shownDock } from './store/app-store';
import { useHasScopeSession, useRepoTabSessionId } from './store/use-root-state';
import { focusedEditorDoc } from './store/workspace-store';

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
    setGroupDialog: s.setGroupDialog,
  };
}

/** 폴더 일괄 흐름 (`useFolderBatchFlows`) — 단축키·팔레트가 실행할 때 부르는 몫 */
type FolderFlows = ReturnType<typeof useFolderBatchFlows>;

/**
 * 폴더 일괄 흐름을 들고 그 대화상자를 그리는 자리 (G2). 이 흐름은 폴더 요약·설정·Project 트리 선택을 구독하므로 앱 루트에서
 * 부르면 요약을 다시 읽거나 트리에서 ↓ 를 누를 때마다 앱 전체가 다시 그려졌다. 여기서 들고 최신 흐름은 `flowsRef` 로만
 * 넘기며, 동작의 활성 여부에 쓰는 "일괄 작업 중" 만 바뀔 때 `onRunning` 으로 알린다
 */
function FolderFlowsHost({
  flowsRef,
  onRunning,
}: {
  flowsRef: MutableRefObject<FolderFlows | null>;
  onRunning: (running: boolean) => void;
}) {
  const flows = useFolderBatchFlows(useBatchReport());
  flowsRef.current = flows;
  useEffect(() => onRunning(flows.running), [flows.running, onRunning]);
  return flows.dialogs.element;
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
  // 저장소 탭의 세션만 본다 (폴더 탭은 동작이 세션에 대고 돌지 않는다 — 범위 세션이 바뀌어도 루트가 다시 그려지지 않게).
  // 활성 여부·제목에 쓰는 값만 원시값으로 구독한다 (`actionSessionOf`, G2)
  const repoTabSession = useRepoTabSessionId();
  const session = useSessionOf(repoTabSession, actionSessionOf);
  const isRepoTab = useIsRepoTab();
  const tabKind = useActiveTab()?.kind ?? null;
  const dialogs = useDialogs();
  // 확인·입력 창은 여는 순간의 것을 쓴다 (`useDialogs` 는 그릴 때마다 새 객체라 의존에 넣으면 동작 목록이 매번 새로 생긴다)
  const dialogsRef = useRef(dialogs);
  dialogsRef.current = dialogs;
  const activeId = useAppStore((s) => s.activeSessionId);
  const openQuickSwitch = useCallback(() => setQuickSwitch(true), [setQuickSwitch]);
  // 폴더 탭의 동기화·branch 단축키·팔레트 항목: 툴바·개요 탭 일괄 줄과 같은 일괄 흐름(대상 = 고른 저장소, 없으면 전부.
  // push 는 체크 목록, branch 만들기·전환은 입력 창)과, 외부 앱으로 열 폴더 루트. 흐름은 `FolderFlowsHost` 가 들고 있다
  const folderFlowsRef = useRef<FolderFlows | null>(null);
  const [folderRunning, setFolderRunning] = useState(false);
  const folderRepoCount = useFolder((f) => f.repos.length) ?? 0;
  // 외부 앱으로 열 곳: 폴더 탭은 폴더 루트, 가상 그룹(루트 디렉터리가 없다)은 활성 저장소 — 없으면 외부 열기만 꺼지고
  // 일괄 동작은 그대로다 (MR-13). 루트가 있는 폴더 탭은 활성 저장소를 구독하지 않는다 (행을 옮길 때마다 다시 그리지 않게)
  const folderDir = useFolder((f) => f.space.dir);
  const folderGroup = useFolder((f) => f.group?.id ?? null) ?? null;
  const folderActiveRepo = useWorkspace((w) => (folderDir == null ? w.activeRepo : null));
  const folderLoaded = useFolder(() => true) ?? false;
  const folderRoot = folderDir ?? folderActiveRepo ?? null;
  const folder = useMemo<FolderActions | undefined>(
    () =>
      tabKind === 'folder' && folderLoaded
        ? {
            enabled: !folderRunning && folderRepoCount > 0,
            root: folderRoot,
            groupId: folderGroup,
            fetch: () => void folderFlowsRef.current?.fetch(),
            pull: () => void folderFlowsRef.current?.pull(),
            push: () => void folderFlowsRef.current?.push(),
            createBranch: () => void folderFlowsRef.current?.createBranch(),
            checkout: () => void folderFlowsRef.current?.checkout(),
            runCommand: () => void folderFlowsRef.current?.runCommand(),
          }
        : undefined,
    [tabKind, folderLoaded, folderRoot, folderGroup, folderRunning, folderRepoCount],
  );
  const startClone = useCallback(
    () =>
      void cloneFlow(dialogsRef.current, {
        pickDirectory: app.pickDirectory,
        cloneRepository: app.cloneRepository,
      }),
    [app.pickDirectory, app.cloneRepository],
  );
  // 여러 저장소 clone: 폴더 탭에서 열면 상위 폴더 선택 창을 그 폴더에서 연다. 가상 그룹 탭은 폴더 디렉터리가 없어(활성
  // 저장소 안에 clone 하지 않도록) 처음 위치를 주지 않는다
  const startCloneMany = useCallback(() => {
    const s = useAppStore.getState();
    void batchCloneFlow(dialogsRef.current, {
      pickDirectory: s.pickDirectory,
      cloneRepositories: s.cloneRepositories,
      notice: s.notice,
      defaultParent: tabKind === 'folder' ? folderDir : null,
    });
  }, [tabKind, folderDir]);
  const startInit = useCallback(
    () =>
      void initFlow(dialogsRef.current, {
        pickDirectory: app.pickDirectory,
        templates: app.templates,
        initRepository: app.initRepository,
      }),
    [app.pickDirectory, app.templates, app.initRepository],
  );
  const promptBranch = useCallback(() => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void createBranchFlow(dialogsRef.current, store.getState().createBranch);
    }
  }, [activeId]);
  const promptCompare = useCallback(() => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void compareFlow(dialogsRef.current, store.getState());
    }
  }, [activeId]);
  const promptColumns = useCallback(() => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void columnsFlow(dialogsRef.current, store.getState());
    }
  }, [activeId]);
  /**
   * 에디터 공간의 활성 탭을 닫는다 (⌘W, 결정 7번 — 폴더 탭 W19, 저장소 탭 W21). 세션 문서의 닫기 규칙(초안 확인)은
   * `closeDoc` 의 몫이다
   */
  const closeEditorDoc = useCallback(() => {
    // 분할 중이면 지금 그룹의 문서를 닫는다 (R3)
    const ws = activeId === null ? undefined : getWorkspaceStore(activeId)?.getState();
    return ws?.closeFocusedDoc() ?? false;
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
        startCloneMany,
        promptBranch,
        promptCompare,
        promptColumns,
        closeEditorDoc,
        openTagsDoc: isRepoTab ? openTagsDocAction : undefined,
        folder,
      }),
    [
      app,
      session,
      isRepoTab,
      tabKind,
      openQuickSwitch,
      startClone,
      startInit,
      startCloneMany,
      promptBranch,
      promptCompare,
      promptColumns,
      closeEditorDoc,
      openTagsDocAction,
      folder,
    ],
  );
  return {
    actions,
    dialogElement: (
      <>
        {dialogs.element}
        <FolderFlowsHost flowsRef={folderFlowsRef} onRunning={setFolderRunning} />
      </>
    ),
  };
}

/**
 * 본문에 넘기는 동작 출처 (D-3). 동작 목록은 쓰기 동작의 시작·끝(busy)·dock 토글마다 새로 만들어지는데, 그것을 본문에 그대로
 * 넘기면 워크스페이스·Git 도구 창이 통째로 다시 그려졌다(파일 하나 stage 에 바쁨 켜짐·꺼짐마다 로그 칸 220 …). 본문은 안내
 * 글자·링크만 그리고 실행은 누를 때 하므로, 지금 목록은 `current()` 로 읽게 하고 출처는 안내 글자·링크 유무가 바뀔 때만 새로
 * 만든다
 */
function useCommandSource(actions: readonly Action[]): CommandSource {
  const latest = useRef(actions);
  // 그린 결과가 화면에 붙은 뒤에 바꾼다 (버려진 렌더의 목록을 실행하지 않게)
  useLayoutEffect(() => {
    latest.current = actions;
  }, [actions]);
  const key = commandSourceKey(actions);
  const current = useCallback(() => latest.current, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 안내 글자·링크 유무(`key`)가 같으면 옛 출처를 그대로 둔다
  return useMemo(() => commandSourceOf(current), [key, current]);
}

/**
 * 전역 단축키 (UX-03): 판단은 `handleGlobalKey` 가 한다. Esc 가 닫는 문서는 활성 탭 워크스페이스(에디터 공간)의 활성
 * 문서다 — 폴더 탭·저장소 탭이 같다 (W21). 세션 문서를 닫으면 워크스페이스가 그 세션 슬롯을 비운다(`closeSessionDoc` —
 * 충돌 초안이 있으면 확인). 폴더 탭은 숨은 세션이 범위 세션이어도 그 세션의 검색을 건드리지 않는다
 */
function useGlobalShortcuts(actions: Action[]): void {
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const isRepoTab = useIsRepoTab();
  // 찾기 줄은 저장소 탭의 세션 것만 본다 (폴더 탭의 범위 세션이 바뀌어도 루트가 다시 그려지지 않게)
  const s = useSessionOf(useRepoTabSessionId(), (st) => ({
    searchOpen: st.search.open,
    setSearchOpen: st.setSearchOpen,
  }));
  // Esc 가 보는 문서는 지금 편집기 그룹의 보고 있는 문서다 (R3)
  const ws = useWorkspace((w) => ({
    doc: focusedEditorDoc(w),
    closeFocusedDoc: w.closeFocusedDoc,
  }));
  const searchOpen = isRepoTab && s.searchOpen;
  const activeDoc = editorKeyDoc(ws?.doc);
  const { setSearchOpen } = s;
  const docId = ws?.doc?.id ?? null;
  const closeFocusedDoc = ws?.closeFocusedDoc;
  useEffect(() => {
    /** 활성 문서를 닫는다 (세션 문서는 워크스페이스가 그 문서의 세션 슬롯을 비운다 — 범위 세션의 화면이 아니라) */
    const closeActiveDoc = () => {
      if (docId !== null) {
        closeFocusedDoc?.();
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
  }, [actions, setPaletteOpen, setSearchOpen, searchOpen, activeDoc, docId, closeFocusedDoc]);
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
function CenterPane({ commands }: { commands: CommandSource }) {
  const activeKind = useActiveTab()?.kind ?? null;
  if (activeKind === null) {
    return <HomeScreen />;
  }
  if (activeKind === 'folder') {
    return <FolderWorkspace commands={commands} />;
  }
  return <RepoWorkspace commands={commands} />;
}

/**
 * 본문: 왼쪽 도구 창 띠 + 아래 도구 창 슬롯으로 감싼 화면. 띠는 슬롯의 바깥 왼쪽에 있어 위 영역과 아래 도구 창
 * 전체 높이에 걸친다. 슬롯은 탭 종류(저장소·폴더·없음)와 무관하게 여기서 한 번만 마운트한다 (WS-02) — 터미널 뷰가
 * 내려가지 않도록 띠가 있든 없든 슬롯의 자리는 바뀌지 않는다
 */
export const AppBody = memo(function AppBody({ commands }: { commands: CommandSource }) {
  return (
    <CommandContext.Provider value={commands}>
      <div className={styles.body}>
        <StripePane />
        <div className={styles.main}>
          <BottomDock>
            <CenterPane commands={commands} />
          </BottomDock>
        </div>
      </div>
    </CommandContext.Provider>
  );
});

/**
 * 툴바·작업 진행 띠·오류 줄 (G2). 각자 필요한 상태를 구독하므로 앱 루트가 다시 그려질 때 함께 다시 그리지 않는다
 */
const AppChrome = memo(function AppChrome({
  isFolderTab,
  isRepoTab,
}: {
  isFolderTab: boolean;
  isRepoTab: boolean;
}) {
  return (
    <>
      <Toolbar />
      {isFolderTab ? <FolderOpBand /> : null}
      {isRepoTab ? <RepoOpBand /> : null}
      <ActionErrorBar />
    </>
  );
});

/** 상태 바 (스스로 구독한다 — 루트가 다시 그려질 때 함께 다시 그리지 않는다) */
const AppStatusBar = memo(StatusBar);

/**
 * 세션·앱 대화상자들 (G2). 탭 종류·범위 세션 유무로만 마운트를 정하고 각 대화상자는 스스로 구독하므로, 앱 루트가 다시 그려질
 * 때 함께 다시 그리지 않는다. 마운트 규칙은 `App` 의 설명과 같다
 */
const AppDialogs = memo(function AppDialogs({
  hasSession,
  isRepoTab,
  isFolderTab,
}: {
  hasSession: boolean;
  isRepoTab: boolean;
  isFolderTab: boolean;
}) {
  return (
    <>
      {hasSession ? <BlameDialog /> : null}
      {hasSession ? <FileHistoryDialog /> : null}
      {isRepoTab ? <HintDialogs /> : null}
      {isFolderTab ? <FolderHints /> : null}
      {isRepoTab ? <ReflogDialog /> : null}
      {isRepoTab ? <FileBackupsDialog /> : null}
      {isRepoTab ? <RebasePlanDialog /> : null}
      {hasSession ? <ComparisonLauncher /> : null}
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
      <GroupDialog />
      <WorkspaceSearch />
      <Toasts />
    </>
  );
});

/** 전체 저장소 집합으로 색을 정하므로 로그 필터·정렬·스크롤은 색을 바꾸지 않는다. */
function ActiveRepositoryPalette({ children }: { children: ReactNode }) {
  const folder = useFolder((state) => ({
    repos: state.repos,
    summaries: state.summaries,
    info: state.timeline.info,
  }));
  const roster = useMemo(
    () => repositoryRosterKey((folder?.repos ?? []).map((repo) => repo.path)),
    [folder?.repos],
  );
  const count = repositorySlotCount(
    (folder?.repos ?? []).map((repo) => repo.path),
    folder?.summaries ?? [],
    folder?.info?.repos ?? [],
  );
  return (
    <RepositoryPaletteProvider count={count} roster={roster}>
      {children}
    </RepositoryPaletteProvider>
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
  const commands = useCommandSource(actions);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const hasSession = useHasScopeSession();
  const isRepoTab = useIsRepoTab();
  const isFolderTab = useActiveTab()?.kind === 'folder';
  // 팔레트에는 그룹마다의 "그룹 열기" 와 (개발·테스트 프로필이면) 성능 자가 진단을 더한다 (단축키 설정 목록에는 넣지 않는다)
  const groups = useAppStore((s) => s.groups);
  const openGroupAt = useAppStore((s) => s.openGroupAt);
  const isOpening = useAppStore((s) => s.isOpening);
  const paletteActions = useMemo(
    () => [
      ...actions,
      ...groupOpenActions(groups, (id) => void openGroupAt(id), !isOpening),
      ...developerActions(runtimeProfile().kind, window.__mgitPerf),
    ],
    [actions, groups, openGroupAt, isOpening],
  );
  return (
    <ActiveRepositoryPalette>
      <div className={styles.app}>
        <AppChrome isFolderTab={isFolderTab} isRepoTab={isRepoTab} />
        <AppBody commands={commands} />
        <AppStatusBar />
        <AppDialogs hasSession={hasSession} isRepoTab={isRepoTab} isFolderTab={isFolderTab} />
        {quickSwitch && isRepoTab ? (
          <BranchQuickSwitch onClose={() => setQuickSwitch(false)} />
        ) : null}
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} actions={paletteActions} />
        <CredentialDialog />
        <CloseSessionDialog />
        <FolderCloseDialog />
        <ConflictLeaveDialog />
        <SettingsDialog actions={actions} />
        {dialogElement}
      </div>
    </ActiveRepositoryPalette>
  );
}
