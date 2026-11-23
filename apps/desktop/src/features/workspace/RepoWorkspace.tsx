import type { RepoChanges, RepoKind, RepoSummary } from '@mgit/ipc';
import { useCallback, useEffect, useMemo } from 'react';
import { type Action, LEFT_TOOL_PANEL } from '../../actions';
import { WorkspaceShell } from '../../layout/WorkspaceShell';
import {
  type EditorDoc,
  headBranchOf,
  type SessionState,
  useActiveTab,
  useAppStore,
  useFileTree,
  useSession,
  useShownLeftTool,
  useWorkspace,
} from '../../store';
import { baseName, innermostRepo, joinRoot, rootToRepo } from '../../store/fs-path';
import { allDocs, fileViewDoc } from '../../store/workspace-store';
import { ChangesPanel } from '../changes/ChangesPanel';
import { RepoCommitTool } from '../commit/RepoCommitTool';
import { SessionConflictPane } from '../conflict/ConflictPane';
import { SessionDiffPane } from '../diff/DiffPane';
import { PullRequestsTool } from '../hosting/PullRequestsTool';
import { useRepoStructure } from '../modules/RepoStructure';
import { buildStatusLookup } from '../project/file-status';
import { type ProjectOpenMode, ProjectTree } from '../project/ProjectTree';
import { type RowDecoration, repoDecoration } from '../project/project-rows';
import { type EntryRow, flattenProjectTree, type RootRow } from '../project/project-tree-model';
import { docDetail, docTitle, docTooltip } from './doc-labels';
import { EditorArea, EditorEmptyState } from './EditorArea';
import { editorHints } from './editor-hints';
import { FileViewDoc, type FileViewRepoTools } from './FileViewDoc';
import { menuTargets } from './folder-tree-menu';
import styles from './RepoWorkspace.module.css';
import { repoTreeMenu } from './repo-tree-menu';
import docStyles from './WorktreeDiffDoc.module.css';

/** 에디터 문서가 가리키는 작업 트리 파일의 루트(작업 트리) 기준 경로 (트리에서 찾기). 없으면 null */
function repoDocTreePath(doc: EditorDoc | undefined): string | null {
  switch (doc?.kind) {
    case 'file':
    case 'worktreeDiff':
    case 'historyDiff':
      return doc.path;
    case 'conflict':
      // 읽는 중인 충돌 문서는 경로가 아직 없다
      return doc.path === '' ? null : doc.path;
    default:
      return null;
  }
}

/** 저장소 탭의 Project 도구 창·에디터 공간이 읽는 세션 상태 */
function pickRepo(st: SessionState) {
  return {
    id: st.id,
    path: st.path,
    name: st.name,
    refs: st.refs,
    summary: st.status.summary,
    entries: st.status.entries,
    op: st.op,
    nestedRepos: st.nestedRepos,
    refresh: st.refresh,
    reloadFiles: st.reloadFiles,
    openFileHistory: st.openFileHistory,
    openBlame: st.openBlame,
    jumpToCommit: st.jumpToCommit,
  };
}

/**
 * 프로젝트 트리 루트 행(작업 트리)의 장식 (PT-02): 폴더 탭의 저장소 행과 같은 규칙(`repoDecoration`)에 세션의 HEAD·
 * 상태를 요약 모양으로 넘긴다. 종류(`kind` — 서브모듈·워크트리면 그 배지)는 `rootRepoKind` 가 정한다 (W25)
 */
function rootDecoration(s: {
  path: string;
  name: string;
  kind: RepoKind;
  refs: SessionState['refs'];
  summary: SessionState['status']['summary'];
  changed: number;
  op: SessionState['op'];
}): RowDecoration {
  const head = s.refs.head;
  const summary: RepoSummary = {
    path: s.path,
    name: s.name,
    kind: s.kind,
    color: 0,
    branch: head.state === 'unborn' ? head.branch : headBranchOf(s.refs),
    detached: head.state === 'detached',
    changed: s.changed,
    conflicted: s.summary.conflicted,
    ahead: s.summary.ahead,
    behind: s.summary.behind,
    op: s.op?.kind ?? null,
    lastFetch: null,
    error: null,
  };
  return repoDecoration({ path: s.path, kind: s.kind }, summary);
}

export interface RepoWorkspaceProps {
  /** 동작 목록. 빈 상태의 단축키 안내가 사용자 재지정을 반영한 단축키를 여기서 읽는다 */
  actions: readonly Action[];
}

/**
 * 저장소 탭의 위 영역 (WS-15, W21): 폴더 탭과 같은 틀(`WorkspaceShell`)에 저장소 세션의 내용을 싣는다. 아래 Git 도구
 * 창의 로그 탭은 `RepoGitLog` 가 맡는다.
 * - 왼쪽 = Project 도구 창(작업 트리를 루트로 하는 파일 트리 하나 — 바뀐 파일의 상태 색·문자, 루트 행에 브랜치·
 *   ahead/behind) 또는 Commit 도구 창(같은 자리에 번갈아). Commit 도구 창은 탭 둘이다 (`RepoCommitTool`, W23): 변경 =
 *   옛 오른쪽 칸의 변경 사항 `ChangesPanel` + 커밋 입력 그대로 | Stash = 옛 사이드바·상세 칸의 스태시. 원격 프로젝트가
 *   있으면 Pull Requests 도구 창(`PullRequestsTool`, W24 — 옛 사이드바의 PR 섹션)도 같은 자리에 뜬다
 * - 가운데 = 에디터 공간: 세션에서 파생한 문서(작업 트리·커밋·범위 파일 diff, 충돌 머지 편집기) + 파일 보기 탭. 문서가
 *   없으면 단축키 안내 (ED-11 — 개요 탭은 없다). 옛 "← 그래프로"·"← 목록으로" 는 탭 닫기가 대신한다 (폴더 탭과 같다)
 * - 파일 트리는 그 탭 세션 스토어의 것이다. Project 도구 창이 처음 보일 때 루트를 읽고, 창 포커스·새로고침·ref 변경(세션
 *   스토어) 때 펼친 디렉터리를 다시 읽는다.
 * - 모듈·서브모듈·하위 저장소·상위 저장소 (W25 — 옛 사이드바의 남은 네 덩이, `useRepoStructure`): 디렉터리 행 장식과 행 메뉴,
 *   머리의 메뉴 단추(접힌 곳에 있어도 닿게), 트리 위 띠(상위 저장소 링크·모듈 범위). 디렉터리의 더블클릭·Enter 는 다른
 *   디렉터리처럼 펼침이고, 저장소 탭으로 열기는 행 메뉴에 있다 (폴더 탭 W11 과 같은 규칙)
 */
export function RepoWorkspace({ actions }: RepoWorkspaceProps) {
  const tabId = useActiveTab()?.id ?? null;
  const s = useSession(pickRepo);
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
  const ws = useWorkspace((w) => ({
    docs: w.docs,
    sessionDocs: w.sessionDocs,
    activeDocId: w.activeDocId,
    openDoc: w.openDoc,
    activateDoc: w.activateDoc,
    closeDoc: w.closeDoc,
    pinDoc: w.pinDoc,
  }));
  // 왼쪽 도구 창: Project·Commit·Pull Requests 가 같은 자리에 번갈아 뜬다 (폭은 폴더 탭과 함께 쓴다, WS-05). 그리는 것은
  // 저장된 값이 아니라 지금 보이는 것이다 — 원격 프로젝트가 없으면 저장된 Pull Requests 대신 Project (W24)
  const leftTool = useShownLeftTool();
  const setLeftTool = useAppStore((st) => st.setLeftTool);

  // 모듈·서브모듈·하위 저장소 (W25): 머리 메뉴에서 고르면 트리에서 그 디렉터리를 드러낸다
  const revealInTree = tree?.reveal;
  const structure = useRepoStructure(
    useCallback((path: string) => void revealInTree?.(path), [revealInTree]),
  );

  // 트리가 처음 보일 때 루트(와 펼쳐 둔 디렉터리 중 안 읽은 것)를 읽는다
  const openTree = tree?.open;
  useEffect(() => openTree?.(), [openTree]);
  // 창 포커스: 펼친 디렉터리를 다시 읽는다 (폴더 탭과 같은 규칙 — 파일 트리는 감시하지 않는다)
  const reloadFiles = s.reloadFiles;
  useEffect(() => {
    const onFocus = () => void reloadFiles();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reloadFiles]);

  const root = s.path;
  const dirs = tree?.dirs;
  const expanded = tree?.expanded;
  const rows = useMemo(
    () => (dirs && expanded ? flattenProjectTree(dirs, expanded) : []),
    [dirs, expanded],
  );
  const order = useMemo(() => rows.map((r) => r.id), [rows]);
  // 메뉴의 "새 탭으로 열기" 대상 판정 (보이는 행 중 파일 보기로 열 수 있는 파일)
  const openableFiles = useMemo(
    () => new Set(rows.flatMap((r) => (r.kind === 'entry' && r.openable ? [r.path] : []))),
    [rows],
  );
  // 파일 날짜의 기준 시각 (PT-10): 나열이 바뀔 때만 새로 잡는다
  // biome-ignore lint/correctness/useExhaustiveDependencies: dirs 는 기준 시각을 새로 잡으라는 신호다
  const now = useMemo(() => Date.now(), [dirs]);
  // 작업 트리 + 그 안의 중첩 저장소 (상태 색에서 중첩 저장소 안을 가른다 — 서브모듈은 넣지 않는다: 상위 저장소의 status 가
  // 서브모듈 디렉터리 자신(포인터 변경)을 알리므로 그 행의 색을 지킨다)
  const { name, refs, summary, entries, op, nestedRepos } = s;
  const repoPaths = useMemo(() => [root, ...nestedRepos], [root, nestedRepos]);
  const statuses = useMemo(() => {
    const changes: RepoChanges[] = [{ path: root, name, branch: null, entries, summary }];
    return buildStatusLookup(root, repoPaths, changes);
  }, [root, name, repoPaths, entries, summary]);
  const rootKind = structure.rootKind;
  const rootDeco = useMemo(
    () =>
      rootDecoration({
        path: root,
        name,
        kind: rootKind,
        refs,
        summary,
        changed: entries.length,
        op,
      }),
    [root, name, rootKind, refs, summary, entries.length, op],
  );
  const structureDecorations = structure.decorations;
  const decorate = useCallback(
    (path: string): RowDecoration | null => {
      const status = statuses.get(path);
      if (path === '') {
        return { ...rootDeco, status };
      }
      // 모듈·서브모듈·하위 저장소 디렉터리면 그 장식에 상태(이름 색)를 더한다
      const deco = structureDecorations.get(path);
      if (deco) {
        return { ...deco, status };
      }
      return status ? { status } : null;
    },
    [statuses, rootDeco, structureDecorations],
  );
  // 탭 막대: 저장한 문서(파일 보기) 뒤에 세션에서 파생한 문서
  const storedDocs = ws?.docs;
  const sessionDocs = ws?.sessionDocs;
  const docs = useMemo(
    () => allDocs({ docs: storedDocs ?? [], sessionDocs: sessionDocs ?? [] }),
    [storedDocs, sessionDocs],
  );
  const hints = useMemo(() => editorHints(actions), [actions]);

  if (!ws || !tree || tabId === null) {
    return null;
  }

  /**
   * 루트 기준 상대 경로가 이 저장소(중첩 저장소·서브모듈 밖)의 파일이면 그 저장소 기준 경로 (작업 트리가 루트라 같다).
   * 서브모듈 안 파일은 상위 저장소가 추적하지 않으므로 히스토리·Blame 을 걸지 않는다 (W25 — 중첩 저장소와 같은 규칙)
   */
  const fileRepo = (rel: string) => {
    const target = rootToRepo(root, structure.ownerRepos, rel);
    return target !== null && target.repoPath === root ? target : null;
  };

  /** 파일 보기 문서를 연다 (PT-04). 선택은 건드리지 않는다 */
  const openDocument = (path: string, mode: ProjectOpenMode) => {
    const repoPath = innermostRepo(structure.ownerRepos, joinRoot(root, path));
    ws.openDoc(
      fileViewDoc({
        path,
        name: baseName(path),
        repoPath,
        repoName: repoPath === null ? null : repoPath === root ? s.name : baseName(repoPath),
      }),
      mode,
    );
  };

  /** 파일을 연다: 그 행 하나를 고르고 문서를 연다 */
  const openFile = (path: string, mode: ProjectOpenMode) => {
    tree.select(path);
    openDocument(path, mode);
  };

  /** 새로고침: 세션 상태와 펼친 디렉터리를 다시 읽는다 */
  const refresh = () => {
    void s.refresh();
    void tree.reload();
  };

  /**
   * 파일 보기 탭 머리줄의 히스토리·Blame (ED-04): 이 저장소의 파일일 때만. 중첩 저장소·서브모듈 안 파일은 그 저장소의
   * 세션이 없어 없다 (`fileRepo`)
   */
  const fileTools = (doc: EditorDoc): FileViewRepoTools | null => {
    const target = doc.kind === 'file' ? fileRepo(doc.path) : null;
    if (!target) {
      return null;
    }
    return {
      repoName: s.name,
      path: target.path,
      onHistory: () => void s.openFileHistory(target.path),
      onBlame: () => void s.openBlame(target.path, null),
    };
  };

  /**
   * 행의 우클릭 메뉴 (PT-07): 루트는 (상위 저장소 열기)·새로고침·경로 복사, 폴더·파일은 폴더 탭과 같은 항목. 서브모듈·하위
   * 저장소·모듈 디렉터리는 그 항목이 앞에 붙는다 (W25)
   */
  const menu = (row: RootRow | EntryRow) =>
    repoTreeMenu(
      {
        row,
        targets: menuTargets(row.id, tree.selection, order),
        root,
        isOpenable: (rel) => openableFiles.has(rel),
        fileRepo,
        roles: structure.roles,
        superproject: structure.superproject,
        scope: structure.scope,
        busy: structure.busy,
      },
      {
        refresh,
        openFile: openDocument,
        fileHistory: (_repo, path) => void s.openFileHistory(path),
        blame: (_repo, path) => void s.openBlame(path, null),
        copy: (text) => void navigator.clipboard.writeText(text).catch(() => {}),
        ...structure.menu,
      },
    );

  /**
   * 문서 종류에 맞는 화면. 세션 문서는 이 탭의 세션 화면이다 (diff = 작업 트리·커밋·범위 파일, 충돌 = 머지 편집기 —
   * 출처 커밋을 누르면 로그에서 그 커밋으로 간다). 파일 보기는 문서마다 새로 마운트한다
   */
  const renderDoc = (doc: EditorDoc) => {
    switch (doc.kind) {
      case 'file':
        return <FileViewDoc key={doc.id} doc={doc} repoTools={fileTools(doc)} />;
      case 'worktreeDiff':
      case 'historyDiff':
        return (
          <div key={doc.id} className={docStyles.doc}>
            <div className={docStyles.pane}>
              <SessionDiffPane sessionId={tabId} repoName={doc.repoName} />
            </div>
          </div>
        );
      case 'conflict':
        return (
          <div key={doc.id} className={docStyles.doc}>
            <div className={docStyles.pane}>
              <SessionConflictPane sessionId={tabId} onJump={(oid) => void s.jumpToCommit(oid)} />
            </div>
          </div>
        );
      case 'overview':
      case 'commitDiff':
        // 폴더 탭의 문서다 (저장소 탭은 커밋 diff 를 세션 문서 `historyDiff` 로 연다)
        return null;
    }
  };

  const activeDoc = docs.find((d) => d.id === ws.activeDocId);
  const locatePath = repoDocTreePath(activeDoc);

  return (
    <WorkspaceShell
      leftPanel={LEFT_TOOL_PANEL[leftTool ?? 'project']}
      leftOpen={leftTool !== null}
      onLeftCollapse={() => setLeftTool(null)}
      left={
        leftTool === 'commit' ? (
          <RepoCommitTool
            changes={
              <div className={styles.changes}>
                <ChangesPanel />
              </div>
            }
          />
        ) : leftTool === 'pullRequests' ? (
          <PullRequestsTool />
        ) : (
          <>
            <ProjectTree
              // 탭마다 새로 마운트해 다른 탭의 스크롤 자리가 섞이지 않게 한다
              key={tabId}
              root={{ name: s.name, detail: root }}
              rows={rows}
              selected={tree.selected}
              selection={tree.selection}
              decorate={decorate}
              now={now}
              tools={structure.tools}
              banner={structure.banner}
              onSelect={tree.select}
              onToggleSelect={tree.toggleInSelection}
              onSelectRange={(id) => tree.selectRange(id, order)}
              onToggle={tree.toggle}
              onOpenFile={openFile}
              onLoadMore={tree.loadMore}
              onRetry={tree.retry}
              menu={menu}
              onRefresh={refresh}
              onLocate={() => {
                if (locatePath !== null) {
                  void tree.reveal(locatePath);
                }
              }}
              locateDisabled={locatePath === null}
              busy={false}
              initialScrollTop={tree.scrollTop()}
              onScrollTopChange={tree.rememberScroll}
              revealSeq={tree.revealSeq}
            />
            {structure.dialogs}
          </>
        )
      }
      editor={
        <EditorArea
          key={tabId}
          docs={docs}
          activeId={ws.activeDocId}
          titleOf={docTitle}
          detailOf={docDetail}
          tooltipOf={docTooltip}
          renderDoc={renderDoc}
          onActivate={ws.activateDoc}
          onClose={ws.closeDoc}
          onPin={ws.pinDoc}
          empty={<EditorEmptyState hints={hints} />}
        />
      }
    />
  );
}
