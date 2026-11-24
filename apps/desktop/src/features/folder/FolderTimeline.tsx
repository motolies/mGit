import { DEFAULT_GRAPH_COLUMNS, GraphView } from '@mgit/graph-view';
import type { FolderBranch, FolderBranches, GraphRevs, GraphRow, TimelineInfo } from '@mgit/ipc';
import { Button, Icon, S } from '@mgit/ui';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { focusPanel } from '../../actions';
import { registerCommand } from '../../command-registry';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { GitLogSplit, isLogEnter, useGitLogSide } from '../../layout/GitLogSplit';
import { getFolderStore, getSessionStore, repoNameOf, useAppStore, useFolder } from '../../store';
import {
  sameSelection,
  type TimelineReveal,
  type TimelineSelection,
  timelineRepoPath,
  timelineScopePending,
} from '../../store/folder-store';
import { requestRepoReword } from '../../store/reword-request';
import { BranchToolbar } from '../branches/BranchToolbar';
import { BranchTree } from '../branches/BranchTree';
import { isFavorite, useBranchFavorites } from '../branches/branch-favorites';
import { branchFocusRevs, folderDefaultRefs, folderFocusScope } from '../branches/branch-focus';
import {
  type BranchTreeExpansion,
  type BranchTreeNode,
  expansionForAll,
  selectionFavorite,
} from '../branches/branch-tree-model';
import {
  buildFolderBranchTree,
  folderBranchFullName,
  folderBranchNodeId,
  headRevs,
  remoteBranchParts,
  revsAfterActivate,
  revsAfterRename,
  sameRevs,
  selectedBranchNodeIds,
  selectedLocalBranch,
  updateTargetsOf,
} from '../branches/folder-branch-tree';
import {
  clearedQuery,
  conditionSummary,
  hasConditions,
  logBodyState,
} from '../filter-bar/filter-model';
import { useBatchReport } from './batch-report';
import { type CheckoutCandidate, useFolderBatchFlows } from './FolderBatchBar';
import { FolderCommitPane } from './FolderCommitPane';
import { FolderLogFilter } from './FolderLogFilter';
import styles from './FolderTimeline.module.css';

// 로그 탭의 분할과 왼쪽 칸 접힘 규칙은 저장소 탭과 함께 쓴다 (W21, `layout/GitLogSplit`). 기존 이름으로도 꺼내 둔다
export {
  BRANCHES_MIN_TOOLWINDOW_WIDTH,
  branchesCollapsed,
  GIT_LOG_SPLIT,
  isTooNarrowForBranches,
} from '../../layout/GitLogSplit';

/** 첫 로드 자리 표시의 행 수 (LG-11) */
const SKELETON_ROWS = 8;

/**
 * 일부 저장소 실패 (LG-11): 범위 안에서 읽지 못한 저장소. 나머지 저장소의 로그는 그대로 보인다. 범위 밖 저장소는
 * 읽지 않았을 뿐 실패가 아니다
 */
export function failedTimelineRepos(info: TimelineInfo | null): { name: string; error: string }[] {
  return (info?.repos ?? []).flatMap((r) =>
    r.inScope && r.error ? [{ name: r.name, error: r.error }] : [],
  );
}

/**
 * 행 우클릭의 범위 항목 (LG-09): 그 행의 저장소 하나만 보는 중이면 "모든 저장소 보기"(범위를 푼다), 아니면 "이
 * 저장소만 보기"(그 저장소 하나로 좁힌다). 돌려주는 값은 바꿀 범위
 */
export function rowScopeAction(
  scope: readonly string[],
  repoPath: string,
): { label: string; scope: string[] } {
  return scope.length === 1 && scope[0] === repoPath
    ? { label: S.folder.timeline.allRepos, scope: [] }
    : { label: S.folder.timeline.onlyThisRepo, scope: [repoPath] };
}

/**
 * 로그 밖에서 고른 커밋(W19 `revealTimelineCommit`)이 지금 로그에 없을 때의 안내: 지금 고른 커밋의 요청이 `missing` 이면
 * 필터·범위가 걸려 있을 때 `filtered`("필터 지우고 보기"를 준다), 아니면 `absent`(보기 옵션·저장소당 상한 등). 그 밖은 null
 */
export function revealNoticeOf(
  reveal: TimelineReveal | null,
  selected: TimelineSelection | null,
  filtered: boolean,
): 'filtered' | 'absent' | null {
  if (reveal === null || reveal.state !== 'missing' || !sameSelection(reveal.of, selected)) {
    return null;
  }
  return filtered ? 'filtered' : 'absent';
}

/** 브랜치 목록을 아직 못 받았을 때의 빈 목록 (메모 의존값이 흔들리지 않게 한 벌만 둔다) */
const NO_BRANCHES: FolderBranches = { repos: [], branches: [] };

/** 저장소 경로 → 이름 (브랜치 목록의 저장소 이름, 없으면 경로의 끝) */
function repoNameIn(repos: FolderBranches['repos'], path: string): string {
  return repos.find((repo) => repo.path === path)?.name ?? repoNameOf(path);
}

/**
 * 이미 그 브랜치에 있는 저장소의 경로. 로컬 브랜치를 고른 것이면 그 브랜치가 현재인 저장소이고,
 * 원격 브랜치를 고른 것이면 그 원격을 추적하는 같은 이름의 로컬 브랜치가 현재인 저장소다
 * (추적하지 않는 같은 이름의 로컬은 그 원격 브랜치와 무관하므로 치지 않는다 — 코어가 건너뛴다)
 */
function currentPathsFor(branches: readonly FolderBranch[], branch: FolderBranch): Set<string> {
  const localName = branch.remote ? remoteBranchParts(branch)?.branch : branch.name;
  const local = branches.find((b) => !b.remote && b.name === localName);
  return new Set(
    (local?.repos ?? [])
      .filter((r) => r.current && (!branch.remote || (r.upstream ?? null) === branch.name))
      .map((r) => r.path),
  );
}

/**
 * 선택이 이 행인지. 공유 이력의 같은 커밋이 저장소마다 한 행씩 있으므로 저장소까지 비교한다. 선택은 저장소
 * 경로로 들고 있으므로 행의 저장소 번호를 지금 타임라인 정보로 경로로 바꿔 비교한다 (재스캔으로 번호가
 * 밀려도 같은 커밋 행이 선택으로 보인다)
 */
export function sameTimelineRow(
  selected: TimelineSelection | null,
  row: GraphRow,
  info: TimelineInfo | null,
): boolean {
  return (
    selected !== null &&
    selected.oid === row.oid &&
    selected.repoPath === timelineRepoPath(info, row.repo)
  );
}

/**
 * Git 도구 창의 로그 탭 (폴더): 통합 타임라인 (MR-12). 맨 왼쪽 세로 툴바 + 브랜치 트리(어느 저장소에
 * 있는지) + 합친 그래프. 브랜치 트리는 항상 렌더하고 접기만 하며, 세로 툴바는 접히는 칸 밖이라 늘 보인다.
 * 브랜치 트리는 폴더 스토어의 브랜치 목록으로 채우므로 타임라인 로드보다 먼저 보인다 (BT-06).
 * 브랜치 트리의 클릭·더블클릭·메뉴가 폴더에서 무엇을 뜻하는지는 여기서 정한다 (BT-03·07):
 * 클릭 = 로그를 그 브랜치로 거르기, 더블클릭·Enter = 그 브랜치와 기본 branch(master·origin/master, 없으면 main)로 거르기,
 * checkout 은 우클릭 메뉴
 */
export function FolderTimeline() {
  const f = useFolder((st) => ({
    id: st.id,
    path: st.path,
    timeline: st.timeline,
    branches: st.branches,
    openTimeline: st.openTimeline,
    reloadTimeline: st.reloadTimeline,
    setTimelineQuery: st.setTimelineQuery,
    setTimelineScope: st.setTimelineScope,
    focusTimelineBranch: st.focusTimelineBranch,
    selectTimelineRow: st.selectTimelineRow,
    revealTimelineCommit: st.revealTimelineCommit,
    ackTimelineReveal: st.ackTimelineReveal,
    revealOnNextLoad: st.revealOnNextLoad,
    resolveTimelineRow: st.resolveTimelineRow,
    rememberTimelineAnchor: st.rememberTimelineAnchor,
    timelineAnchor: st.timelineAnchor,
  }));
  const openRepositoryAt = useAppStore((s) => s.openRepositoryAt);
  const logRef = useRef<HTMLDivElement>(null);
  const [expansion, setExpansion] = useState<BranchTreeExpansion>({});
  const [favorites, setFavorites] = useBranchFavorites(f?.path ?? null);
  // 브랜치 목록 칸의 펼침 (사용자의 선택 + 좁은 폭 자동 접힘, WS-06)
  const side = useGitLogSide();
  // 상세의 부모·자식으로 옮길 때 로그를 그 행으로 스크롤한다
  const [scrollToRow, setScrollToRow] = useState<number | null>(null);
  const clearScroll = useCallback(() => setScrollToRow(null), []);
  const t = S.folder.timeline;
  const opened = f?.timeline.opened ?? true;
  const openTimeline = f?.openTimeline;

  // 탭을 처음 켤 때 코어에 열기를 요청한다
  useEffect(() => {
    if (!opened && openTimeline) {
      void openTimeline();
    }
  }, [opened, openTimeline]);

  // 질의·범위를 바꾼 뒤 보던 커밋이 새 결과에 없으면 맨 위로 간다 (있으면 뷰가 스스로 그 커밋으로 간다, LG-10).
  // 마운트할 때의 값은 지난 일이므로 보지 않는다 (탭을 오가며 다시 마운트돼도 보던 자리에서 시작한다)
  const scrollReset = f?.timeline.scrollReset ?? 0;
  const seenReset = useRef(scrollReset);
  useEffect(() => {
    if (scrollReset !== seenReset.current) {
      seenReset.current = scrollReset;
      setScrollToRow(0);
    }
  }, [scrollReset]);

  const info = f?.timeline.info ?? null;
  const folderId = f?.id ?? null;
  const columns = useMemo(() => ({ ...DEFAULT_GRAPH_COLUMNS, repo: true }), []);
  const repoOf = useCallback(
    (row: GraphRow) => {
      const idx = row.repo ?? null;
      const r = idx === null ? undefined : info?.repos[idx];
      return r ? { name: r.name, color: r.color } : undefined;
    },
    [info],
  );
  const dimRow = useCallback((row: GraphRow) => !row.inHead, []);
  const selectedRow = f?.timeline.selected ?? null;
  const isRowSelected = useCallback(
    (row: GraphRow) => sameTimelineRow(selectedRow, row, info),
    [selectedRow, info],
  );

  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    const unregister = [
      registerCommand('log.reword', element, {
        enabled: () => selectedRow !== null && folderId !== null,
        run: () => {
          if (selectedRow && folderId !== null)
            void requestRepoReword(folderId, selectedRow.repoPath, selectedRow.oid);
        },
      }),
      registerCommand('log.copyHash', element, {
        enabled: () => selectedRow !== null,
        run: () => {
          if (selectedRow) void navigator.clipboard.writeText(selectedRow.oid).catch(() => {});
        },
      }),
    ];
    return () => {
      for (const remove of unregister) remove();
    };
  }, [selectedRow, folderId]);

  /** 그 저장소를 하위 탭으로 열고 커밋으로 이동한다 (행 우클릭 "저장소 탭으로 열기", LG-09) */
  const openInRepo = useCallback(
    async (row: GraphRow) => {
      const idx = row.repo ?? null;
      const r = idx === null || folderId === null ? undefined : info?.repos[idx];
      if (!r || folderId === null) {
        return;
      }
      const id = await openRepositoryAt(r.path, folderId);
      if (id !== null) {
        getSessionStore(id)?.getState().jumpToCommitWhenLoaded(row.oid);
      }
    },
    [folderId, info, openRepositoryAt],
  );

  // 브랜치 트리·세로 툴바에서 실행한 일괄 작업의 결과는 토스트로 알린다
  const flows = useFolderBatchFlows(useBatchReport());

  const revealCommit = f?.revealTimelineCommit;
  /**
   * 상세의 부모·자식을 눌렀을 때 (CD-02): 그 커밋을 고르고(상세가 바뀐다) 로그에서 그 행을 보이게 한다 (W19 — blame·
   * 히스토리 해시와 같은 길 `revealTimelineCommit`). 지금 질의에 그 커밋이 없으면 로그 위에 안내가 뜬다
   */
  const navigate = useCallback(
    (target: TimelineSelection) => revealCommit?.(target.repoPath, target.oid),
    [revealCommit],
  );

  // 로그 밖에서 고른 커밋을 찾았으면 그 행으로 한 번 스크롤한다 (W19). 로그 탭이 나중에 마운트돼도 스크롤한다
  const reveal = f?.timeline.reveal ?? null;
  const revealSeq = reveal?.state === 'found' && !reveal.scrolled ? reveal.seq : null;
  const revealRow = reveal?.row ?? null;
  const ackReveal = f?.ackTimelineReveal;
  useEffect(() => {
    if (revealSeq !== null && revealRow !== null) {
      setScrollToRow(revealRow);
      ackReveal?.(revealSeq);
    }
  }, [revealSeq, revealRow, ackReveal]);

  // 브랜치 목록은 타임라인과 따로 읽는다 (PF-03): 로그 로드가 끝나기 전에도 트리가 채워진다 (BT-06)
  const branchList = f?.branches ?? null;
  const { branches, repos: branchRepos } = branchList ?? NO_BRANCHES;
  const revs = f?.timeline.query.revs;
  const hideRemotes = f?.timeline.query.hideRemotes ?? false;
  const nodes = useMemo(
    () =>
      buildFolderBranchTree({
        branches,
        repos: branchRepos,
        isFavorite: (fullName) => isFavorite(favorites, fullName),
        hideRemotes,
      }),
    [branches, branchRepos, favorites, hideRemotes],
  );
  const selectedIds = useMemo(
    () => (revs ? selectedBranchNodeIds(revs, branches) : []),
    [revs, branches],
  );

  // 브랜치 트리에 넘기는 콜백 (W27 — W22 가 저장소 탭에서 한 것과 같은 방식): 로그 행을 고를 때마다 새로 만들지 않아,
  // memo 된 트리(행 240~300 컴포넌트)가 다시 그려지지 않게 한다. 콜백은 브랜치 목록·질의가 바뀔 때만 새로 만든다.
  // 일괄 흐름(`flows`)은 그릴 때마다 새 함수라 누른 순간의 것을 참조로 읽는다 (지금까지와 같은 값이다)
  const flowsRef = useRef(flows);
  useLayoutEffect(() => {
    flowsRef.current = flows;
  });
  const timelineQuery = f?.timeline.query;
  const setTimelineQuery = f?.setTimelineQuery;

  /** 로그의 ref 범위를 바꾼다. 같은 범위면 다시 읽지 않는다 (더블클릭의 두 번째 클릭) */
  const setRevs = useCallback(
    (next: GraphRevs) => {
      if (timelineQuery && setTimelineQuery && !sameRevs(timelineQuery.revs, next)) {
        void setTimelineQuery({ ...timelineQuery, revs: next });
      }
    },
    [timelineQuery, setTimelineQuery],
  );
  /** 노드가 가리키는 브랜치. HEAD 행·그룹이면 null */
  const branchOf = useCallback(
    (node: BranchTreeNode) => branches.find((b) => folderBranchNodeId(b) === node.id) ?? null,
    [branches],
  );

  /** 잎을 눌렀을 때 (BT-03): 로그를 그 브랜치로 거른다. HEAD 행은 저장소마다 자기 HEAD 의 이력만 본다 */
  const activate = useCallback(
    (node: BranchTreeNode, { additive }: { additive: boolean }) => {
      if (node.kind === 'head') {
        setRevs(headRevs());
        return;
      }
      const branch = branchOf(node);
      if (branch && timelineQuery) {
        setRevs(revsAfterActivate(timelineQuery.revs, branch.name, additive));
      }
    },
    [setRevs, branchOf, timelineQuery],
  );

  const focusTimelineBranch = f?.focusTimelineBranch;
  /**
   * 더블클릭·Enter (BT-03): checkout 하지 않고 로그를 그 브랜치와 기본 branch 로 거르고, 저장소 범위를 그 브랜치가 있는
   * 저장소로 좁힌다 — 그 저장소마다 master(없으면 main)와 그 원격 짝(업스트림, 없으면 origin/<기본>)을 모아 함께 본다
   * (`folderDefaultRefs`·`folderFocusScope`). 좁힌 저장소 범위는 branch 범위가 바뀌면 스토어가 걸기 전으로 되돌린다
   * (`focusTimelineBranch`). HEAD 행·그룹은 아무것도 하지 않는다. checkout 은 우클릭 메뉴로 한다
   */
  const focus = useCallback(
    (node: BranchTreeNode) => {
      const branch = branchOf(node);
      if (branch && focusTimelineBranch) {
        void focusTimelineBranch(
          branchFocusRevs(branch.name, folderDefaultRefs(branches, branch)),
          folderFocusScope(branch, branchRepos),
        );
      }
    },
    [branchOf, branches, branchRepos, focusTimelineBranch],
  );

  /**
   * checkout (BT-07): 그 브랜치를 가진 저장소를 체크 목록으로 확인받고 폴더 일괄 checkout 을 부른다.
   * 원격 브랜치는 저장소마다 그 원격을 추적하는 같은 이름의 로컬 브랜치로(없으면 만들어) checkout 한다.
   * 모든 저장소에서 이미 현재 브랜치면 할 일이 없다
   */
  const checkout = useCallback(
    (node: BranchTreeNode) => {
      const branch = branchOf(node);
      if (!branch || node.current === true) {
        return;
      }
      const current = currentPathsFor(branches, branch);
      const candidates: CheckoutCandidate[] = branch.repos.map((r) => ({
        path: r.path,
        name: repoNameIn(branchRepos, r.path),
        current: current.has(r.path),
      }));
      const remote = branch.remote ? remoteBranchParts(branch) : null;
      void flowsRef.current.checkoutBranch(
        remote ? { name: branch.name, remote } : { name: branch.name },
        candidates,
        remote ? S.folder.timeline.checkoutTracking : undefined,
      );
    },
    [branchOf, branches, branchRepos],
  );

  /**
   * 이름 변경 (로컬 branch): 새 이름과 그 branch 를 가진 저장소를 체크 목록으로 확인받고 폴더 일괄로 바꾼다. 바꾼 저장소가
   * 있으면 로그 범위의 옛 이름을 새 이름으로 바꾼다(그대로 두면 사라진 이름으로 걸려 로그가 빈다). 범위는 일괄이 끝난
   * 순간의 질의를 스토어에서 읽는다. 즐겨찾기는 저장소 탭의 이름 변경처럼 옮기지 않는다
   */
  const renameBranch = useCallback(
    async (branch: FolderBranch) => {
      const done = await flowsRef.current.renameBranch(
        branch.name,
        branch.repos.map((r) => ({ path: r.path, name: repoNameIn(branchRepos, r.path) })),
      );
      const renamed = done?.result?.results.filter((r) => r.ok && !r.skipped).length ?? 0;
      const live = folderId === null ? undefined : getFolderStore(folderId)?.getState();
      if (!done || renamed === 0 || !live) {
        return;
      }
      const query = live.timeline.query;
      const next = revsAfterRename(query.revs, branch.name, done.to, renamed < branch.repos.length);
      if (!sameRevs(query.revs, next)) {
        void live.setTimelineQuery({ ...query, revs: next });
      }
    },
    [branchRepos, folderId],
  );

  /** 한 브랜치의 즐겨찾기를 뒤집는다 */
  const toggleFavorite = useCallback(
    (node: BranchTreeNode) => {
      if (node.fullName) {
        setFavorites([node.fullName], !node.favorite);
      }
    },
    [setFavorites],
  );

  /** 브랜치 행의 우클릭 메뉴 (BT-07). HEAD 행·그룹에는 메뉴가 없다. 꺼짐(일괄 작업 중)은 메뉴를 여는 순간의 값이다 */
  const menu = useCallback(
    (node: BranchTreeNode): MenuItem[] => {
      const branch = branchOf(node);
      if (!branch) {
        return [];
      }
      const running = flowsRef.current.running;
      // branch 업데이트 (BR-09): 로컬 branch 만. 그 branch 가 있고 업스트림이 있는 저장소가 없으면 사유를 이름에 적고 끈다
      const targets = updateTargetsOf(branch);
      const update: MenuItem[] = branch.remote
        ? []
        : [
            {
              label:
                targets.length > 0
                  ? S.branches.menu.updateIn(targets.length)
                  : S.branches.menu.updateNone,
              disabled: targets.length === 0 || running,
              onSelect: () => void flowsRef.current.updateBranch(branch.name, targets),
            },
          ];
      // 이름 변경: 로컬 branch 만 (원격 branch 는 이름을 바꾸지 않는다)
      const rename: MenuItem[] = branch.remote
        ? []
        : [
            {
              label: S.menu.rename,
              commandId: 'branch.rename',
              disabled: running,
              onSelect: () => void renameBranch(branch),
            },
          ];
      return [
        {
          label: S.branches.menu.checkout,
          commandId: 'branch.checkout',
          disabled: node.current === true || running,
          onSelect: () => checkout(node),
        },
        ...update,
        {
          label: S.branches.menu.newBranchHere,
          disabled: running,
          // "여기서 새 branch…": 그 브랜치를 가진 저장소 중 체크한 저장소에서 그 브랜치를 시작점으로 만든다
          onSelect: () =>
            void flowsRef.current.createBranchFrom(
              { fullName: folderBranchFullName(branch), name: branch.name },
              branch.repos.map((r) => ({ path: r.path, name: repoNameIn(branchRepos, r.path) })),
            ),
        },
        ...rename,
        {
          label: S.branches.menu.showOnly,
          onSelect: () => setRevs({ kind: 'solo', name: branch.name }),
        },
        {
          label: node.favorite ? S.branches.removeFavorite : S.branches.addFavorite,
          separator: true,
          onSelect: () => toggleFavorite(node),
        },
        {
          label: S.menu.copyName,
          onSelect: () => void navigator.clipboard.writeText(branch.name).catch(() => {}),
        },
      ];
    },
    [branchOf, checkout, setRevs, toggleFavorite, branchRepos, renameBranch],
  );

  if (!f) {
    return null;
  }
  const tl = f.timeline;
  const query = tl.query;
  const filtered = hasConditions(query) || tl.scope.length > 0;
  const scopePending = timelineScopePending(info, tl.scope);
  const body =
    scopePending && tl.loadState !== 'error'
      ? 'skeleton'
      : logBodyState({ loadState: tl.loadState, totalRows: tl.totalRows, filtered });
  const failed = failedTimelineRepos(info);
  /** 필터 지우기 (결과 없음 상태): 필터 바의 "모두 지우기"와 같다 */
  const clearFilters = () => {
    if (hasConditions(query)) {
      void f.setTimelineQuery(clearedQuery(query));
    }
    if (tl.scope.length > 0) {
      void f.setTimelineScope([]);
    }
  };
  // 로그 밖에서 고른 커밋이 지금 로그에 없을 때의 안내 (W19)
  const revealNotice = revealNoticeOf(tl.reveal, tl.selected, filtered);
  /** "필터 지우고 보기": 필터·범위를 지우고, 다시 읽은 로그에서 그 커밋을 다시 고르고 보인다 */
  const showUnfiltered = () => {
    if (tl.reveal !== null) {
      f.revealOnNextLoad(tl.reveal.of);
    }
    clearFilters();
  };
  // 세로 툴바의 즐겨찾기: 선택한 브랜치들이 모두 즐겨찾기면 끄고, 아니면 모두 켠다
  const picked = selectionFavorite(nodes, selectedIds);
  // 세로 툴바의 "선택한 branch 업데이트" (BR-09): 고른 로컬 branch 하나의, 업스트림이 있는 저장소에서
  const updatePick = selectedLocalBranch(branches, selectedIds);
  const updatePaths = updatePick ? updateTargetsOf(updatePick) : [];
  const updateTitle =
    updatePick && updatePaths.length > 0
      ? S.folder.batch.withScope(
          `${S.branches.toolbar.update}: ${updatePick.name}`,
          S.folder.batch.repoGroup(updatePaths.length),
        )
      : S.branches.toolbar.updateNone;

  /** 로그에서 Enter (W19 ③): 고른 커밋의 변경 파일 트리로 포커스를 옮긴다 (IntelliJ 의 로그 → 상세) */
  const onLogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isLogEnter(e)) {
      e.preventDefault();
      focusPanel('git-detail');
    }
  };

  return (
    <GitLogSplit
      side={side}
      resizeBranchesLabel={t.resizeBranches}
      resizeDetailLabel={t.resizeDetail}
      onLogKeyDown={onLogKeyDown}
      detail={<FolderCommitPane onNavigate={navigate} />}
      toolbar={
        <BranchToolbar
          panelOpen={!side.collapsed}
          panelLocked={side.tooNarrow ? t.branchesTooNarrow : undefined}
          onTogglePanel={() => side.setOpen(!side.open)}
          busy={flows.running}
          newBranchTitle={S.folder.batch.withScope(S.branches.toolbar.newBranch, flows.scope)}
          fetchTitle={S.folder.batch.withScope(S.branches.toolbar.fetch, flows.scope)}
          onNewBranch={() => void flows.createBranch()}
          onFetch={() => void flows.fetch()}
          onUpdate={() => {
            if (updatePick) {
              void flows.updateBranch(updatePick.name, updatePaths);
            }
          }}
          updateDisabled={flows.running || updatePaths.length === 0}
          updateTitle={updateTitle}
          favorite={picked.favorite}
          onToggleFavorite={() => setFavorites(picked.fullNames, !picked.favorite)}
          onExpandAll={() => setExpansion(expansionForAll(nodes, true))}
          onCollapseAll={() => setExpansion(expansionForAll(nodes, false))}
        />
      }
      branches={
        // 폴더가 바뀌면 검색어와 커서를 새로 시작한다
        <BranchTree
          key={f.id}
          multiselectable
          nodes={nodes}
          selectedIds={selectedIds}
          expansion={expansion}
          onExpansionChange={setExpansion}
          onActivate={activate}
          onOpen={focus}
          menu={menu}
          onToggleFavorite={toggleFavorite}
          // 브랜치 목록을 아직 못 받았으면 읽는 중이다 (타임라인 로드와 무관하다)
          emptyText={branchList === null ? t.loading : undefined}
        />
      }
      log={
        <div ref={logRef} style={{ display: 'contents' }}>
          {/* 필터 바 (LG-06·08, W17): branch 드롭다운은 브랜치 트리와 같은 상태(질의의 ref 범위)다 */}
          <FolderLogFilter branchNodes={nodes} branchRepos={branchRepos} />
          {/* 다시 읽기 실패: 이전 결과가 있으면 그 위에 알리고 다시 시도를 준다 */}
          {tl.error && body === 'rows' ? (
            <div className={styles.notice} data-tone="error" role="alert">
              <Icon name="error" />
              <span className={styles.noticeText}>{t.failed(tl.error)}</span>
              <button
                type="button"
                className={styles.noticeAction}
                onClick={() => void f.reloadTimeline()}
              >
                {t.retry}
              </button>
            </div>
          ) : null}
          {/* 일부 저장소 실패 (LG-11): 로그는 보이고 읽지 못한 저장소 이름을 알린다 */}
          {failed.length > 0 ? (
            <div
              className={styles.notice}
              data-tone="warn"
              title={failed.map((r) => `${r.name}: ${r.error}`).join('\n')}
            >
              <Icon name="warning" />
              <span className={styles.noticeText}>
                {t.partialFailed(failed.length, failed.map((r) => r.name).join(', '))}
              </span>
            </div>
          ) : null}
          {/* 로그 밖에서 고른 커밋이 지금 질의·범위의 로그에 없다 (W19): 상세는 그대로 보인다 */}
          {revealNotice !== null ? (
            <div
              className={styles.notice}
              data-tone="info"
              role="status"
              title={revealNotice === 'filtered' ? undefined : t.revealAbsentTitle}
            >
              <Icon name="search" />
              <span className={styles.noticeText}>
                {revealNotice === 'filtered' ? t.revealFiltered : t.revealAbsent}
              </span>
              {revealNotice === 'filtered' ? (
                <button type="button" className={styles.noticeAction} onClick={showUnfiltered}>
                  {t.revealClear}
                </button>
              ) : null}
            </div>
          ) : null}
          {body === 'skeleton' ? (
            <div className={styles.skeleton} role="status" aria-busy="true" aria-label={t.loading}>
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 자리 표시 행은 순서만 있다
                <div key={i} className={styles.skeletonRow}>
                  <span />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : body === 'error' ? (
            <div className={styles.state} role="alert">
              <span>{t.failed(tl.error ?? S.error.unknown)}</span>
              <Button onClick={() => void f.reloadTimeline()}>{t.retry}</Button>
            </div>
          ) : body === 'empty' ? (
            <div className={styles.state}>{t.empty}</div>
          ) : body === 'noMatch' ? (
            <div className={styles.state}>
              <span>{t.noMatch}</span>
              <span className={styles.conditions}>
                {conditionSummary(query, {
                  now: new Date(),
                  authorLabel: (email) =>
                    tl.authors.list?.authors.find(
                      (a) => a.email.toLowerCase() === email.toLowerCase(),
                    )?.name ?? email,
                  scopeNames: tl.scope.map(
                    (path) => info?.repos.find((r) => r.path === path)?.name ?? repoNameOf(path),
                  ),
                }).join(' · ')}
              </span>
              <Button onClick={clearFilters}>{t.clearFilters}</Button>
            </div>
          ) : (
            <ContextMenuArea<GraphRow>
              className={styles.menuArea}
              resolveTarget={(e) => {
                const el = (e.target as HTMLElement | null)?.closest('[data-oid]');
                const oid = el?.getAttribute('data-oid');
                const rowAttr = el?.getAttribute('data-row');
                if (!oid || rowAttr === null || rowAttr === undefined) {
                  return null;
                }
                const slice = tl.cache.slice(Number(rowAttr), Number(rowAttr) + 1);
                return slice.rows[0] ?? null;
              }}
              items={(row) => {
                const repoPath = timelineRepoPath(info, row.repo);
                const scoped = repoPath === null ? null : rowScopeAction(tl.scope, repoPath);
                return [
                  {
                    label: S.menu.copyHash,
                    commandId: 'log.copyHash',
                    onSelect: () => void navigator.clipboard.writeText(row.oid).catch(() => {}),
                  },
                  {
                    label: S.menu.copySubject,
                    onSelect: () => void navigator.clipboard.writeText(row.subject).catch(() => {}),
                  },
                  {
                    label: S.menu.reword,
                    commandId: 'log.reword',
                    disabled: repoPath === null,
                    onSelect: () => {
                      if (repoPath !== null) void requestRepoReword(f.id, repoPath, row.oid);
                    },
                  },
                  {
                    label: t.openInRepo,
                    separator: true,
                    onSelect: () => void openInRepo(row),
                  },
                  // 이 저장소만 보기 / 모든 저장소 보기 (LG-09)
                  ...(scoped
                    ? [
                        {
                          label: scoped.label,
                          onSelect: () => void f.setTimelineScope(scoped.scope),
                        },
                      ]
                    : []),
                ];
              }}
            >
              {/* 키에 세대를 넣지 않는다: 다시 읽혀도 뷰를 유지해야 보던 커밋으로 돌아갈 수 있다 (LG-10).
                      뷰가 내려갔다 올라오는 경우(콘솔 탭 왕복·도구 창 숨김)는 스토어가 기억한 기준에서 시작한다.
                      목록 모드(선 없음)와 그래프는 따로 마운트한다 — 뷰는 본 레인 수로 그래프 열 폭을 늘리기만 하고
                      줄이지 않으므로, 같은 뷰로 목록을 그리면 넓은 빈 그래프 열이 남는다 (스토어가 그 전에 보던 커밋을
                      새 결과에서 찾아 시작 기준으로 준다) */}
              <GraphView
                key={`${f.id}:${tl.listMode ? 'list' : 'graph'}`}
                cache={tl.cache}
                totalRows={tl.totalRows}
                columns={columns}
                repoOf={repoOf}
                dimRow={dimRow}
                resolveRow={f.resolveTimelineRow}
                initialAnchor={f.timelineAnchor()}
                onAnchorChange={f.rememberTimelineAnchor}
                selectedOid={tl.selected?.oid ?? null}
                isRowSelected={isRowSelected}
                scrollToRow={scrollToRow}
                onScrolledTo={clearScroll}
                // 고르면 오른쪽 칸에 변경 파일·상세가 뜬다 (LG-07). 같은 행을 다시 눌러도 저장소 탭으로
                // 가지 않는다 — 저장소 탭은 우클릭 메뉴로 연다 (LG-09)
                onSelectRow={(row) => {
                  const repoPath = timelineRepoPath(info, row.repo);
                  if (repoPath !== null) {
                    f.selectTimelineRow(repoPath, row.oid);
                  }
                }}
              />
            </ContextMenuArea>
          )}
        </div>
      }
    >
      {flows.dialogs.element}
    </GitLogSplit>
  );
}
