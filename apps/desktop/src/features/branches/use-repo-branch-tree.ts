// 저장소 탭 브랜치 트리의 컨테이너 (BT-11, W22): 세션 상태를 트리 노드로 바꾸고, 클릭·더블클릭·메뉴·머리 단추·세로
// 툴바가 무엇을 뜻하는지 정해 공용 뷰(`BranchTree`·`BranchToolbar`)의 props 로 넘긴다. 펼침·고른 행·검색어는 탭의
// 워크스페이스에 두어 로그 탭이 내려갔다 와도 남는다.
//
// 재렌더 (W18 ②): 세션에서 트리에 필요한 것만 고르고(그래프 선택·status 는 고르지 않는다) 노드 배열·콜백을 안정하게
// 만든다 — memo 한 `BranchTree` 가 로그 행 선택·status 변경에 다시 그려지지 않는다.

import type { SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { type ReactNode, useCallback, useMemo } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import type { GitLogSide } from '../../layout/GitLogSplit';
import { headBranchOf, useAppStore, useSession, useWorkspace } from '../../store';
import { type BranchTreeViewState, INITIAL_BRANCH_TREE_VIEW } from '../../store/workspace-store';
import { createBranchFlow } from '../home/repo-flows';
import type { BranchToolbarProps } from './BranchToolbar';
import type { BranchTreeProps } from './BranchTree';
import { isFavorite, useBranchFavorites } from './branch-favorites';
import {
  type BranchTreeExpansion,
  type BranchTreeNode,
  expansionForAll,
  selectionFavorite,
} from './branch-tree-model';
import {
  openRepoBranch,
  type RepoBranchDeps,
  repoBranchMenu,
  repoBranchRowActions,
} from './repo-branch-menu';
import {
  buildRepoBranchTree,
  type RepoBranchSource,
  repoBranchTarget,
  repoTargetCommit,
} from './repo-branch-tree';

/** 컨테이너가 만든 것: 세로 툴바와 트리의 props, 대화상자 요소 */
export interface RepoBranchTreeParts {
  /** 트리의 key (탭이 바뀌면 커서를 새로 시작한다) */
  key: SessionId;
  toolbar: BranchToolbarProps;
  tree: BranchTreeProps;
  /** 확인·입력 대화상자 (트리 곁에 둔다) */
  dialogs: ReactNode;
}

/** 이름을 클립보드에 넣는다 (옛 사이드바 "이름 복사"와 같다 — 실패는 조용히 넘긴다) */
function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * 저장소 탭 브랜치 트리의 상태와 동작 (BT-11). 클릭·Space = 그 커밋으로 이동(로그 탭이 열리고 그 행으로, 결정 16번),
 * 더블클릭·Enter = checkout 류(`openRepoBranch`), 우클릭 = 옛 사이드바 메뉴(`repoBranchMenu`), Worktrees 그룹 끝 단추 =
 * 정리·만들기. 세로 툴바(BT-05): 접기, 새 branch(⌘⇧B 와 같은 흐름), Fetch(툴바 Fetch 와 같다), 즐겨찾기, 모두 펼치기·접기
 */
export function useRepoBranchTree(side: GitLogSide): RepoBranchTreeParts {
  const s = useSession((st) => ({
    id: st.id,
    path: st.path,
    labels: st.refs.labels,
    head: st.refs.head,
    worktrees: st.refs.worktrees,
    hasRemotes: st.refs.remotes.length > 0,
    headBranch: headBranchOf(st.refs),
    backups: st.backups,
    radar: st.radar,
    busy: st.busy,
    op: st.op,
    isolatedBranch: st.isolatedBranch,
    graphQuery: st.graphQuery,
    jumpToCommit: st.jumpToCommit,
    createBranch: st.createBranch,
    checkout: st.checkout,
    setGraphQuery: st.setGraphQuery,
    openCompare: st.openCompare,
    merge: st.merge,
    openMergePreview: st.openMergePreview,
    openRebasePreview: st.openRebasePreview,
    isolatedMerge: st.isolatedMerge,
    rebase: st.rebase,
    renameBranch: st.renameBranch,
    setUpstream: st.setUpstream,
    deleteBranch: st.deleteBranch,
    fetch: st.fetch,
    push: st.push,
    deleteRemoteBranch: st.deleteRemoteBranch,
    deleteTag: st.deleteTag,
    backupRestore: st.backupRestore,
    backupDelete: st.backupDelete,
    worktreeRemoveCheck: st.worktreeRemoveCheck,
    worktreeRemove: st.worktreeRemove,
    worktreeLock: st.worktreeLock,
    worktreeUnlock: st.worktreeUnlock,
    worktreePrune: st.worktreePrune,
    suggestWorktreePath: st.suggestWorktreePath,
    worktreeAdd: st.worktreeAdd,
  }));
  const openRepositoryAt = useAppStore((st) => st.openRepositoryAt);
  const view: BranchTreeViewState = useWorkspace((w) => w.branchTree) ?? INITIAL_BRANCH_TREE_VIEW;
  const setView = useWorkspace((w) => w.setBranchTree);
  const [favorites, setFavorites] = useBranchFavorites(s.path === '' ? null : s.path);
  const dialogs = useDialogs();
  const { confirm, prompt } = dialogs;

  const source = useMemo<RepoBranchSource>(
    () => ({
      labels: s.labels,
      head: s.head,
      worktrees: s.worktrees,
      backups: s.backups,
      radar: s.radar,
      path: s.path,
    }),
    [s.labels, s.head, s.worktrees, s.backups, s.radar, s.path],
  );
  const nodes = useMemo(
    () =>
      buildRepoBranchTree({
        ...source,
        isFavorite: (fullName) => isFavorite(favorites, fullName),
      }),
    [source, favorites],
  );

  // 메뉴·더블클릭·머리 단추가 부르는 동작 묶음. 세션에서 고른 값(`s`)이 같으면 같은 객체다
  const deps = useMemo<RepoBranchDeps>(
    () => ({
      state: {
        id: s.id,
        path: s.path,
        busy: s.busy,
        inOp: s.op !== null,
        headBranch: s.headBranch,
        isolatedBranch: s.isolatedBranch,
        graphQuery: s.graphQuery,
        prunable: s.worktrees.filter((w) => w.prunable !== null).length,
      },
      session: s,
      dialogs: { confirm, prompt },
      openRepositoryAt,
      copyText,
    }),
    [s, confirm, prompt, openRepositoryAt],
  );

  const jumpToCommit = s.jumpToCommit;
  /** 잎을 누르면(클릭·Space) 그 행을 고르고 그 커밋으로 이동한다. 워크트리 행은 고르기만 한다 (옛 사이드바에 클릭 동작 없음) */
  const onActivate = useCallback(
    (node: BranchTreeNode) => {
      setView?.({ selected: [node.id] });
      const target = repoBranchTarget(node.id, source);
      const oid = target ? repoTargetCommit(target) : null;
      if (oid !== null) {
        void jumpToCommit(oid);
      }
    },
    [setView, source, jumpToCommit],
  );
  /** 더블클릭·Enter: checkout 류 (`openRepoBranch`) */
  const onOpen = useCallback(
    (node: BranchTreeNode) => {
      const target = repoBranchTarget(node.id, source);
      if (target) {
        openRepoBranch(target, deps);
      }
    },
    [source, deps],
  );
  /** 우클릭 메뉴. 대상이 없는 노드(Local·Remote·Tags·Backups 그룹)는 빈 목록이라 메뉴를 열지 않는다 */
  const menu = useCallback(
    (node: BranchTreeNode) => {
      const target = repoBranchTarget(node.id, source);
      return target ? repoBranchMenu(target, deps) : [];
    },
    [source, deps],
  );
  const rowActions = useCallback(
    (node: BranchTreeNode) => repoBranchRowActions(node.id, deps),
    [deps],
  );
  const onToggleFavorite = useCallback(
    (node: BranchTreeNode) => {
      if (node.fullName) {
        setFavorites([node.fullName], !node.favorite);
      }
    },
    [setFavorites],
  );
  const onExpansionChange = useCallback(
    (expansion: BranchTreeExpansion) => setView?.({ expansion }),
    [setView],
  );
  const onSearchChange = useCallback((search: string) => setView?.({ search }), [setView]);

  const picked = selectionFavorite(nodes, view.selected);
  const t = S.workspace.repoLog;
  return {
    key: s.id,
    toolbar: {
      panelOpen: !side.collapsed,
      panelLocked: side.tooNarrow ? t.sideTooNarrow : undefined,
      onTogglePanel: () => side.setOpen(!side.open),
      // 새 branch 는 ⌘⇧B 와 같은 조건(다른 작업 실행 중이 아님), fetch 는 툴바의 Fetch 와 같은 조건
      busy: s.busy,
      fetchDisabled: s.busy || s.op !== null || !s.hasRemotes,
      onNewBranch: () => void createBranchFlow(dialogs, s.createBranch),
      onFetch: () => void s.fetch(null, true),
      favorite: picked.favorite,
      onToggleFavorite: () => setFavorites(picked.fullNames, !picked.favorite),
      onExpandAll: () => setView?.({ expansion: expansionForAll(nodes, true) }),
      onCollapseAll: () => setView?.({ expansion: expansionForAll(nodes, false) }),
    },
    tree: {
      nodes,
      selectedIds: view.selected,
      expansion: view.expansion,
      onExpansionChange,
      onActivate,
      onOpen,
      menu,
      onToggleFavorite,
      search: view.search,
      onSearchChange,
      rowActions,
    },
    dialogs: dialogs.element,
  };
}
