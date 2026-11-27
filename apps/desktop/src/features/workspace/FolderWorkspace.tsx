import { S } from '@mgit/ui';
import { useCallback, useEffect, useMemo } from 'react';
import type { CommandSource } from '../../components/command-context';
import { WorkspaceShell } from '../../layout/WorkspaceShell';
import {
  type EditorDoc,
  OVERVIEW_DOC,
  useAppStore,
  useFileTree,
  useFolder,
  useShownLeftTool,
  useWorkspace,
} from '../../store';
import { markExplicitRefresh } from '../../store/explicit-refresh';
import { fileEditors } from '../../store/file-editor-store';
import { parseNoteRowId } from '../../store/file-tree';
import { baseName, childPath, innermostRepo, relativeTo, rootToRepoIn } from '../../store/fs-path';
import { dirSpace, type RootSpace } from '../../store/root-space';
import { useEditorMarks } from '../../store/use-file-editors';
import { fileViewDoc, focusedEditorDoc } from '../../store/workspace-store';
import { FolderCommitTool } from '../commit/FolderCommitTool';
import { useBatchReport } from '../folder/batch-report';
import { Dashboard } from '../folder/Dashboard';
import { useFolderBatchFlows } from '../folder/FolderBatchBar';
import { FolderCommitDiff } from '../folder/FolderCommitDiff';
import { FolderSettingsDialog } from '../folder/FolderSettingsDialog';
import { ComparisonDoc } from '../history/ComparisonDoc';
import { openFileComparison } from '../history/comparison';
import { ownEntries } from '../project/file-actions-menu';
import { buildStatusLookupIn } from '../project/file-status';
import { ManagedProjectTree } from '../project/ManagedProjectTree';
import type { ProjectOpenMode } from '../project/ProjectTree';
import { type RowDecoration, repoDecorations } from '../project/project-rows';
import { type EntryRow, flattenProjectTree, type RootRow } from '../project/project-tree-model';
import { useFileActions } from '../project/use-file-actions';
import { useProjectFilter } from '../project/use-project-filter';
import { ConflictDoc } from './ConflictDoc';
import { docDetail, docTitle, docTooltip } from './doc-labels';
import { EditorEmptyState } from './EditorArea';
import { FileViewDoc, type FileViewRepoTools } from './FileViewDoc';
import { type FileMenuSource, folderTreeMenu, menuTargets } from './folder-tree-menu';
import { useRepoSessionActions } from './repo-session-actions';
import { SplitEditorArea } from './SplitEditorArea';
import { useEditorFileMenu } from './use-current-file';
import { WorktreeDiffDoc } from './WorktreeDiffDoc';

/**
 * 문서 종류에 맞는 화면. 커밋 diff·파일 보기는 문서마다 새로 마운트해 다른 파일의 응답이 섞이지 않게 한다.
 * 파일 보기는 저장소 안 파일이면 히스토리·Blame 진입(`repoTools`)을 받는다 (ED-04). 작업 트리 diff 탭·충돌 편집기 탭은
 * 저장소마다 하나이고 같은 저장소의 다른 파일이면 같은 화면의 내용이 바뀐다 (ED-05·06)
 */
function renderDoc(doc: EditorDoc, repoTools: (doc: EditorDoc) => FileViewRepoTools | null) {
  switch (doc.kind) {
    case 'comparison':
      return <ComparisonDoc key={doc.id} doc={doc} />;
    case 'overview':
      return <Dashboard />;
    case 'commitDiff':
    case 'rangeDiff':
      return <FolderCommitDiff key={doc.id} doc={doc} />;
    case 'file':
      return <FileViewDoc key={doc.id} doc={doc} repoTools={repoTools(doc)} />;
    case 'worktreeDiff':
      return <WorktreeDiffDoc key={doc.id} doc={doc} />;
    case 'conflict':
      return <ConflictDoc key={doc.id} doc={doc} />;
    case 'historyDiff':
      // 저장소 탭만 파생한다 (W20). 폴더 탭은 커밋 diff 를 폴더 API 문서(`commitDiff`)로 연다
      return null;
    case 'tags':
      // 저장소 탭의 문서다 (C3a, 폴더 탭은 tag 관리를 하지 않는다)
      return null;
  }
}

/** 에디터 문서가 가리키는 작업 트리 파일의 루트 기준 상대 경로 (트리에서 찾기). 없으면 null */
function docTreePath(doc: EditorDoc | undefined, space: RootSpace): string | null {
  if (doc?.kind === 'file') {
    return doc.path;
  }
  if (
    doc?.kind === 'commitDiff' ||
    doc?.kind === 'rangeDiff' ||
    doc?.kind === 'worktreeDiff' ||
    doc?.kind === 'conflict'
  ) {
    const repo = space.toRel(doc.repoPath);
    return repo === null ? null : childPath(repo, doc.path);
  }
  return null;
}

/** 폴더 스토어가 아직 없을 때의 빈 공간 (화면은 그리지 않는다 — 훅 순서를 지키려고 값만 채운다) */
const NO_SPACE = dirSpace('');

export interface FolderWorkspaceProps {
  /**
   * 동작 출처 (D-3). 빈 상태의 단축키 안내(사용자 재지정 반영)와 링크를 여기서 읽는다. 동작의 활성 여부가 바뀌어도(쓰기
   * 동작의 시작·끝) 그대로인 참조라 워크스페이스가 다시 그려지지 않는다
   */
  commands: CommandSource;
}

/**
 * 폴더 탭의 위 영역 (WS-01): 폴더 스토어·파일 트리·워크스페이스 스토어를 읽어 화면 틀의 슬롯을 채운다.
 * 왼쪽 = Project 도구 창(폴더 전체의 파일 트리, 저장소 디렉터리에 요약 장식, 바뀐 파일의 상태 색·문자, 파일의
 * 날짜·크기) 또는 Commit 도구 창(같은 자리에 번갈아, W14), 가운데 = 에디터 공간(개요 문서, 커밋 파일 diff 탭, 파일
 * 보기 탭, 저장소 세션에서 파생한 작업 트리 diff 탭). 활성 저장소(WS-07)는 트리의
 * 기준 행(마지막으로 고른 행)이 저장소 안에 있을 때, 파일을 열 때, 그리고 에디터 탭이 활성화될 때(워크스페이스
 * 스토어) 바뀐다. 트리는 다중 선택이고(PT-07) 선택 중 저장소 행이 일괄 작업의 대상이다 — 개요 탭의 체크박스와
 * 한 상태다. 화면이 떠 있는 동안 요약의 창 포커스·주기 재조회를 켜 둔다 (MR-03) — 개요 탭을 닫아도 요약은
 * 갱신된다. 파일 상태 색을 위해 변경 목록을 한 번 읽어 두면 그 뒤로는 폴더 스토어의 갱신이 함께 다시 읽는다
 */
export function FolderWorkspace({ commands }: FolderWorkspaceProps) {
  const editorFileMenu = useEditorFileMenu();
  const f = useFolder((st) => ({
    id: st.id,
    path: st.path,
    space: st.space,
    group: st.group,
    name: st.name,
    repos: st.repos,
    summaries: st.summaries,
    changes: st.changes,
    loading: st.loading,
    refresh: st.refresh,
    rescan: st.rescan,
    startAutoRefresh: st.startAutoRefresh,
    ensureChanges: st.ensureChanges,
    setSettingsOpen: st.setSettingsOpen,
  }));
  // 탭의 ● 표시가 바뀔 때만 다시 그린다 (편집기 저장소의 다른 변화·바뀐 것 없는 검사에는 깨지 않는다, F1)
  useEditorMarks(f?.id ?? null);
  const tree = useFileTree((t) => ({
    dirs: t.dirs,
    expanded: t.expanded,
    selected: t.selected,
    selection: t.selection,
    revealSeq: t.revealSeq,
    open: t.open,
    toggle: t.toggle,
    select: t.select,
    toggleInSelection: t.toggleInSelection,
    selectRange: t.selectRange,
    loadMore: t.loadMore,
    retry: t.retry,
    reload: t.reload,
    reveal: t.reveal,
    rememberScroll: t.rememberScroll,
    scrollTop: t.scrollTop,
  }));
  const flows = useFolderBatchFlows(useBatchReport());
  const ws = useWorkspace((w) => ({
    // 트리에서 찾기는 지금 편집기 그룹의 보고 있는 문서를 본다 (R3)
    focusedDoc: focusedEditorDoc(w),
    openDoc: w.openDoc,
    setActiveRepo: w.setActiveRepo,
    retainActiveRepo: w.retainActiveRepo,
  }));
  // 왼쪽 도구 창: Project 와 Commit 이 같은 자리에 번갈아 뜬다 (폭은 함께 쓴다, WS-05). 저장된 값이 Pull Requests(저장소
  // 탭 전용, W24)여도 폴더 탭은 Project 를 보인다 — 띠의 강조·접기와 같은 값(`useShownLeftTool`)을 본다
  const leftTool = useShownLeftTool();
  const setLeftTool = useAppStore((s) => s.setLeftTool);
  const openRepositoryAt = useAppStore((s) => s.openRepositoryAt);
  // 저장소 세션 기능 (W13): 파일 히스토리·blame. 세션은 요청할 때만 열린다
  const repoActions = useRepoSessionActions();

  const startAutoRefresh = f?.startAutoRefresh;
  useEffect(() => startAutoRefresh?.(), [startAutoRefresh]);
  // 트리가 처음 보일 때 루트(와 펼쳐 둔 디렉터리 중 안 읽은 것)를 읽는다
  const openTree = tree?.open;
  useEffect(() => openTree?.(), [openTree]);
  // 파일 상태 색 (PT-06): 통합 변경 보기와 같은 변경 목록을 한 번 읽어 둔다
  const ensureChanges = f?.ensureChanges;
  useEffect(() => ensureChanges?.(), [ensureChanges]);

  const space = f?.space ?? NO_SPACE;
  const dirs = tree?.dirs;
  const expanded = tree?.expanded;
  const treeRows = useMemo(
    () => (dirs && expanded ? flattenProjectTree(dirs, expanded) : []),
    [dirs, expanded],
  );
  // 파일 날짜의 기준 시각 (PT-10): 나열이 바뀔 때만 새로 잡는다 — 시계 때문에 행을 다시 그리지 않는다
  // biome-ignore lint/correctness/useExhaustiveDependencies: dirs 는 기준 시각을 새로 잡으라는 신호다
  const now = useMemo(() => Date.now(), [dirs]);
  const repos = f?.repos;
  const summaries = f?.summaries;
  const changes = f?.changes;
  const repoPaths = useMemo(() => (repos ?? []).map((r) => r.path), [repos]);
  // 재스캔으로 활성 저장소가 저장소 목록에서 빠지면 비운다 (WS-07: 없는 저장소를 가리키지 않게). 목록은 폴더를 열 때
  // 응답으로 받아 늘 있다 — 폴더 스토어가 없으면(null) 판단하지 않는다
  const retainActiveRepo = ws?.retainActiveRepo;
  useEffect(
    () => retainActiveRepo?.(repos ? repoPaths : null),
    [retainActiveRepo, repos, repoPaths],
  );
  const decorations = useMemo(
    () => repoDecorations(repos ?? [], summaries ?? []),
    [repos, summaries],
  );
  const statuses = useMemo(
    () => buildStatusLookupIn(space, repoPaths, changes ?? []),
    [space, repoPaths, changes],
  );
  // 보기 거르기 (R1): 이름 필터·변경된 파일만. 범위 선택·메뉴 대상·"새 탭으로 열기" 는 보이는(거른) 행 기준이다
  const { rows, filter } = useProjectFilter({
    session: f?.id ?? null,
    rows: treeRows,
    dirs,
    statuses,
  });
  const order = useMemo(() => rows.map((r) => r.id), [rows]);
  // 메뉴의 "새 탭으로 열기" 대상 판정 (보이는 행 중 파일 보기로 열 수 있는 파일)
  const openableFiles = useMemo(
    () => new Set(rows.flatMap((r) => (r.kind === 'entry' && r.openable ? [r.path] : []))),
    [rows],
  );
  // 그룹 맨 위의 별칭 행 중 지금 저장소가 없는 멤버 (MR-13): 별칭 → 상태 ("찾을 수 없음"·"저장소 아님")
  const lostMembers = useMemo(
    () =>
      new Map(
        (f?.group?.members ?? []).flatMap((m) =>
          m.state === 'present' ? [] : [[m.alias, m.state] as const],
        ),
      ),
    [f?.group],
  );
  const decorate = useCallback(
    (path: string): RowDecoration | null => {
      const lost = lostMembers.get(path);
      if (lost) {
        return { detail: S.group.state[lost] };
      }
      const abs = space.toAbs(path);
      const repo = abs === null ? undefined : decorations.get(abs);
      const status = statuses.get(path);
      return repo || status ? { ...repo, status } : null;
    },
    [decorations, statuses, space, lostMembers],
  );
  const hints = commands.hints;
  // 파일 메뉴 동작 (Finder·터미널·변경 되돌리기·ignore): 쓰기는 그 저장소의 가벼운 세션에 대고, 끝나면 트리를 다시 읽는다
  // (트리는 감시하지 않는다 — 상태 색은 폴더 스토어가 코어의 폴더 변경 알림으로 다시 읽는다)
  const reloadTree = tree?.reload;
  const fileActions = useFileActions({
    rollback: (repoPath, paths) => repoActions?.rollback(repoPath, paths) ?? Promise.resolve(false),
    ignoreAdd: (repoPath, patterns) =>
      repoActions?.ignoreAdd(repoPath, patterns) ?? Promise.resolve(false),
    after: () => void reloadTree?.(),
    repoName: (repoPath) => summaries?.find((s) => s.path === repoPath)?.name ?? baseName(repoPath),
  });

  if (!f || !ws || !tree) {
    return null;
  }

  /** 상대 경로가 속한 가장 안쪽 저장소의 절대 경로 (없으면 null) */
  const repoOf = (path: string) => {
    const abs = space.toAbs(path);
    return abs === null ? null : innermostRepo(repoPaths, abs);
  };
  /** 저장소 경로의 이름 (요약 이름, 없으면 경로의 마지막 요소) */
  const repoName = (repoPath: string) =>
    f.summaries.find((s) => s.path === repoPath)?.name ?? baseName(repoPath);

  /**
   * 디렉터리를 펼치거나 접는다. 그룹의 "저장소 아님" 멤버는 코어가 그 아래 경로를 거부하므로 펼치지 않고 편집 안내를
   * 보인다 (없는 멤버는 펼치면 "없음"이다)
   */
  const toggle = (path: string) => {
    if (lostMembers.get(path) === 'notRepo') {
      useAppStore.getState().notice({ kind: 'info', title: S.group.notRepoHint });
      return;
    }
    tree.toggle(path);
  };

  /** 기준 행이 저장소(나 그 안의 항목)면 활성 저장소가 그 저장소가 된다 (WS-07). 로그·에디터는 그대로 */
  const follow = (id: string) => {
    if (parseNoteRowId(id) === null) {
      ws.setActiveRepo(repoOf(id));
    }
  };

  /** 행 하나만 고른다 (그냥 클릭·화살표·선택 밖 행의 우클릭) */
  const select = (id: string) => {
    tree.select(id);
    follow(id);
  };

  /** ⌘클릭: 선택에 더하거나 뺀다. 그 행이 기준 행이 되고, 더했을 때만 활성 저장소가 따라간다 */
  const toggleSelect = (id: string) => {
    const adding = tree.selection[id] !== true;
    tree.toggleInSelection(id);
    if (adding) {
      follow(id);
    }
  };

  /** ⇧클릭·⇧↑↓: 범위 시작 행부터 그 행까지 (보이는 행 순서) */
  const selectRange = (id: string) => {
    tree.selectRange(id, order);
    follow(id);
  };

  /**
   * 파일 보기 문서를 연다. 선택은 건드리지 않는다 (메뉴의 "새 탭으로 열기" 가 여러 파일을 열 때 선택을 지키게).
   * 문서가 활성화되며 활성 저장소가 그 파일의 저장소가 된다
   */
  const openDocument = (path: string, mode: ProjectOpenMode) => {
    const repoPath = repoOf(path);
    ws.openDoc(
      fileViewDoc({
        path,
        name: baseName(path),
        repoPath,
        repoName: repoPath === null ? null : repoName(repoPath),
      }),
      mode,
    );
  };

  /** 파일을 연다 (PT-04). 그 행 하나를 고르고 문서를 연다 */
  const openFile = (path: string, mode: ProjectOpenMode) => {
    tree.select(path);
    openDocument(path, mode);
  };

  /** 새로고침: 요약·브랜치·변경과 펼친 디렉터리를 다시 읽고, 편집기의 Blame·HEAD 원문도 다시 묻게 한다 (G1) */
  const refresh = () => {
    markExplicitRefresh(f.id);
    void f.refresh();
    void tree.reload();
  };

  /** 루트 기준 상대 경로가 저장소 디렉터리면 그 저장소 */
  const repoAt = (rel: string) => {
    const abs = space.toAbs(rel);
    return abs !== null && decorations.has(abs) ? { path: abs, name: repoName(abs) } : null;
  };
  /** 파일의 가장 안쪽 저장소와 그 저장소 기준 경로. 세션 기능을 쓸 수 없으면 null (메뉴·머리줄에 항목을 두지 않는다) */
  const fileRepo = (rel: string) => (repoActions ? rootToRepoIn(space, repoPaths, rel) : null);
  /** 파일 보기 탭 머리줄의 히스토리·Blame (ED-04): 저장소 안 파일일 때만 */
  const fileTools = (doc: EditorDoc): FileViewRepoTools | null => {
    const target = doc.kind === 'file' ? fileRepo(doc.path) : null;
    if (!target || !repoActions) {
      return null;
    }
    return {
      repoName: repoName(target.repoPath),
      path: target.path,
      onHistory: () => repoActions.history(target.repoPath, target.path),
      onBlame: () => repoActions.blame(target.repoPath, target.path, null),
    };
  };
  /**
   * 파일 메뉴의 변경 동작 재료: 행을 품은 가장 안쪽 저장소와 그 기준 경로, 그 저장소의 변경 목록(안쪽 저장소 항목 제외).
   * 저장소 세션을 쓸 수 없으면 없다 (Finder·터미널만)
   */
  const files: FileMenuSource | undefined = repoActions
    ? {
        target: (rel) => {
          const abs = space.toAbs(rel);
          const repoPath = repoOf(rel);
          return abs === null || repoPath === null
            ? null
            : { repoPath, path: relativeTo(repoPath, abs) ?? '' };
        },
        entriesOf: (repoPath) =>
          ownEntries(
            repoPath,
            repoPaths,
            f.changes.find((c) => c.path === repoPath)?.entries ?? [],
          ),
      }
    : undefined;
  /** 행의 우클릭 메뉴 (PT-07). 대상은 우클릭한 행이 선택에 있으면 선택 전체, 아니면 그 행 */
  const menu = (row: RootRow | EntryRow) =>
    folderTreeMenu(
      {
        row,
        targets: menuTargets(row.id, tree.selection, order),
        space,
        repoAt,
        isOpenable: (rel) => openableFiles.has(rel),
        fileRepo,
        repoCount: f.repos.length,
        busy: flows.running,
        files,
      },
      {
        refresh,
        rescan: () => void f.rescan(),
        openSettings: () => f.setSettingsOpen(true),
        openRepoTab: (repoPath) => void openRepositoryAt(repoPath, f.id),
        openFile: openDocument,
        fetch: (paths) => void flows.fetch(paths),
        pull: (paths) => void flows.pull(paths),
        push: (paths) => void flows.push(paths),
        createBranch: (paths) => void flows.createBranch(paths),
        checkout: (paths) => void flows.checkout(paths),
        worktree: (paths) => void flows.worktree(paths),
        compare: (repoPath, path) => {
          void useAppStore
            .getState()
            .withRepoSession(f.id, repoPath, (state) =>
              openFileComparison(state.id, repoPath, path),
            );
        },
        fileHistory: (repoPath, path) => repoActions?.history(repoPath, path),
        blame: (repoPath, path) => repoActions?.blame(repoPath, path, null),
        copy: (text) => void navigator.clipboard.writeText(text).catch(() => {}),
        files: fileActions.actions,
      },
    );

  const locatePath = docTreePath(ws.focusedDoc, space);

  return (
    <>
      <WorkspaceShell
        leftPanel={leftTool === 'commit' ? 'commit' : 'project'}
        leftOpen={leftTool !== null}
        onLeftCollapse={() => setLeftTool(null)}
        left={
          leftTool === 'commit' ? (
            <FolderCommitTool />
          ) : (
            <ManagedProjectTree
              protectedPaths={repoPaths}
              session={f.id}
              space={f.space}
              // 폴더 탭마다 새로 마운트해 다른 폴더의 스크롤 자리가 섞이지 않게 한다
              key={f.id}
              root={{
                name: f.name,
                detail: f.group ? S.group.rootDetail(f.group.members.length) : f.path,
              }}
              rows={rows}
              filter={filter}
              selected={tree.selected}
              selection={tree.selection}
              decorate={decorate}
              now={now}
              notice={f.repos.length === 0 ? S.folder.empty : null}
              onSelect={select}
              onToggleSelect={toggleSelect}
              onSelectRange={selectRange}
              onToggle={toggle}
              onOpenFile={openFile}
              onLoadMore={tree.loadMore}
              onRetry={tree.retry}
              menu={menu}
              onRefresh={refresh}
              onRescan={() => void f.rescan()}
              onLocate={() => {
                if (locatePath !== null) {
                  filter?.showPath(locatePath);
                  void tree.reveal(locatePath);
                }
              }}
              onSettings={() => f.setSettingsOpen(true)}
              locateDisabled={locatePath === null}
              busy={f.loading}
              initialScrollTop={tree.scrollTop()}
              onScrollTopChange={tree.rememberScroll}
              revealSeq={tree.revealSeq}
            />
          )
        }
        editor={
          <SplitEditorArea
            dirtyOf={(doc) => doc.kind === 'file' && fileEditors.hasDirty(f.id, doc.path)}
            key={f.id}
            titleOf={docTitle}
            detailOf={docDetail}
            tooltipOf={docTooltip}
            renderDoc={(doc) => renderDoc(doc, fileTools)}
            tabMenu={editorFileMenu}
            empty={
              <EditorEmptyState
                hints={hints}
                action={{
                  label: S.workspace.empty.openOverview,
                  onClick: () => ws.openDoc(OVERVIEW_DOC, 'pinned'),
                }}
              />
            }
          />
        }
      />
      {flows.dialogs.element}
      {fileActions.element}
      <FolderSettingsDialog />
    </>
  );
}
