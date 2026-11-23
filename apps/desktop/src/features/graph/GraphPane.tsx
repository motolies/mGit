import { type ExtraWip, GraphView } from '@mgit/graph-view';
import { type GraphQuery, type GraphRow, isListModeQuery } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { focusPanel, showCommitChanges } from '../../actions';
import { ContextMenuArea } from '../../components/ContextMenu';
import { hasModifier } from '../../components/roving';
import { str, useDialogs } from '../../components/use-dialogs';
import { isLogEnter } from '../../layout/GitLogSplit';
import {
  getSessionCache,
  headBranchOf,
  isDefaultGraphQuery,
  type LoadState,
  repoNameOf,
  useAppStore,
  useSession,
  useWorkspace,
} from '../../store';
import { clearedQuery, conditionSummary, hasConditions } from '../filter-bar/filter-model';
import { CommitGraphBanner } from './CommitGraphBanner';
import styles from './GraphPane.module.css';
import { GraphSearch } from './GraphSearch';
import { graphMenuItems } from './graph-menu';
import { PerfBanner } from './PerfBanner';
import { RepoLogFilter } from './RepoLogFilter';
import {
  describeScopedPath,
  type LogMount,
  listRowsVerdict,
  nextLogMount,
} from './repo-log-filter';

/** 로그의 행 이동 키 (commit 행이 없을 때 WIP 행으로 보낸다) */
const ROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * 키보드로 고른 WIP 행(로그 맨 위)이 보이게 한다 (W27). 행이 그려져 있으면 그 행이 보이게만, 화면 밖이라 그려져 있지
 * 않으면 로그를 맨 위로 민다 (그래프 뷰의 스크롤 상자 — 표의 바로 아래 자식)
 */
function revealWipRow(grid: HTMLElement): void {
  const wip = grid.querySelector<HTMLElement>('[data-row="wip"]');
  if (wip) {
    wip.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  const scroller = grid.querySelector<HTMLElement>(':scope > [role="presentation"]');
  if (scroller) {
    scroller.scrollTop = 0;
  }
}

/**
 * 그래프 전체가 "커밋 없음" 화면인지. 조건을 건 0행은 그 조건 때문일 수 있으므로 머리글·필터 바를 남겨
 * 사용자가 조건을 풀 수 있게 한다
 */
export function isGraphEmpty(g: {
  totalRows: number;
  loadState: LoadState;
  hasChanges: boolean;
  query: GraphQuery;
}): boolean {
  return (
    g.totalRows === 0 && g.loadState === 'complete' && !g.hasChanges && isDefaultGraphQuery(g.query)
  );
}

/**
 * 저장소 탭의 로그(Git 도구 창 로그 탭의 가운데 칸, W21): 위에서부터 commit-graph·성능 안내, 필터 바(`RepoLogFilter`,
 * W26 — 옛 머리줄·필터 바의 자리), 찾기 줄(`GraphSearch` — 열었을 때), 본문(커밋 그래프 + 우클릭 메뉴, 또는 상태 안내).
 * 필터 바는 읽는 중·실패·빈 저장소에도 보인다 — 조건 때문에 그렇게 됐어도 풀 수 있게. 진행 중 작업 배너는 툴바 아래 작업
 * 진행 띠로 옮겼다 (`RepoOpBand`, W21 ②).
 * "변경 사항 (WIP)" 행은 고르기와 활성화를 나눈다 (W27): 첫 commit 행에서 ↑ 는 WIP 행을 고르기만 한다(상세 칸이 변경
 * 요약이 된다 — 왼쪽 도구 창은 그대로). 누르거나(클릭) WIP 행을 고른 채 Enter 를 누르면 활성화 — 왼쪽에 Commit 도구 창의
 * 변경 탭이 열리고 포커스가 간다 (Stash 탭을 보던 중이어도 — `showCommitChanges`, W23). commit 행에서 Enter 는 상세 칸으로
 * 포커스를 옮긴다 (폴더 탭과 같은 키 — `isLogEnter`)
 */
export function GraphPane() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const revealCommitChanges = useAppStore((s) => s.revealCommitChanges);
  const setDockMaximized = useAppStore((s) => s.setDockMaximized);
  const s = useSession((st) => ({
    id: st.id,
    loadState: st.loadState,
    totalRows: st.totalRows,
    error: st.error,
    resolveRow: st.resolveRow,
    summary: st.status.summary,
    wipSelected: st.wipSelected,
    selectedCommit: st.selectedCommit,
    selectWip: st.selectWip,
    selectCommit: st.selectCommit,
    searchOpen: st.search.open,
    searchRows: st.search.rows,
    scrollToRow: st.scrollToRow,
    consumeScroll: st.consumeScroll,
    checkout: st.checkout,
    createBranch: st.createBranch,
    createTag: st.createTag,
    cherryPick: st.cherryPick,
    revert: st.revert,
    reset: st.reset,
    rebase: st.rebase,
    merge: st.merge,
    suggestWorktreePath: st.suggestWorktreePath,
    worktreeAdd: st.worktreeAdd,
    openRebasePlan: st.openRebasePlan,
    openMergePreview: st.openMergePreview,
    openRebasePreview: st.openRebasePreview,
    openRemergeDiff: st.openRemergeDiff,
    rewordCommit: st.rewordCommit,
    squashIntoParent: st.squashIntoParent,
    commitMessageOf: st.commitMessageOf,
    worktreeWips: st.worktreeWips,
    signingInfo: st.signingInfo,
    range: st.range,
    selectRange: st.selectRange,
    graphColumns: st.graphColumns,
    graphQuery: st.graphQuery,
    setGraphQuery: st.setGraphQuery,
    graphAuthors: st.graphAuthors.list,
    moduleScope: st.moduleScope,
    modules: st.modules,
    dimOffHead: st.graphView.dimOffHead,
    avatars: st.avatars,
    requestAvatars: st.requestAvatars,
    busy: st.busy,
    op: st.op,
    headBranch: headBranchOf(st.refs),
  }));
  const dialogs = useDialogs();
  const openRepositoryAt = useAppStore((st) => st.openRepositoryAt);
  // 로그는 Git 도구 창의 탭이라 콘솔·터미널로 바꾸거나 숨기면 내려간다 (W21): 다시 붙을 때 보던 자리에서 시작한다
  const anchor = useWorkspace((w) => ({ remember: w.rememberLogAnchor, recall: w.logAnchor }));
  // 현재 브랜치 밖 흐리게: 머지 제외 모드에선 도달성이 끊기므로 끈다
  const dimOn = s.dimOffHead && !s.graphQuery.noMerges;
  const dimRow = useMemo(() => (dimOn ? (row: GraphRow) => !row.inHead : undefined), [dimOn]);
  const cache = activeSessionId === null ? undefined : getSessionCache(activeSessionId);
  // 다른 워크트리의 WIP 행 (WT-06)
  const extraWips = useMemo<ExtraWip[]>(
    () =>
      s.worktreeWips.map((w) => ({
        key: w.path,
        label: w.branch ?? repoNameOf(w.path),
        summary: w.summary,
        headOid: w.head,
      })),
    [s.worktreeWips],
  );
  /** 브랜치 라벨을 행에 놓으면 merge/rebase 를 고른다 (GRAPH-09) */
  const onDropRef = useCallback(
    (refName: string, _row: GraphRow) => {
      const head = s.headBranch;
      if (!head || refName === head) {
        return;
      }
      void dialogs
        .prompt({
          title: S.dnd.title(refName, head),
          fields: [
            {
              key: 'action',
              label: S.dnd.choose,
              type: 'select',
              initial: 'merge',
              options: [
                { value: 'merge', label: S.dnd.merge },
                { value: 'noFf', label: S.dnd.mergeNoFf },
                { value: 'ffOnly', label: S.dnd.mergeFfOnly },
                { value: 'rebase', label: S.dnd.rebase(head) },
              ],
            },
          ],
          confirmLabel: S.dnd.run,
        })
        .then((v) => {
          if (!v) {
            return;
          }
          const action = str(v, 'action');
          if (action === 'rebase') {
            return s.rebase(refName, true);
          }
          return s.merge(refName, action === 'merge' ? 'default' : (action as 'noFf' | 'ffOnly'));
        });
    },
    [dialogs, s.headBranch, s.merge, s.rebase],
  );
  const highlight = useMemo(() => new Set(s.searchRows), [s.searchRows]);
  // 범위 선택 행 (GRAPH-10)
  const rangeRows = useMemo(() => {
    const set = new Set<number>();
    if (s.range) {
      for (let i = s.range.from; i <= s.range.to; i++) {
        set.add(i);
      }
    }
    return set;
  }, [s.range]);
  // 목록 모드(텍스트·작성자 필터·머지 제외 — 선 없음)와 그래프는 로그 뷰를 따로 마운트한다 (W26, `nextLogMount`): 뷰는 본
  // 레인 수로 그래프 열 폭을 늘리기만 해서, 같은 뷰로 목록을 그리면 넓은 빈 열이 남는다. 다시 마운트해도 보던 자리는
  // 워크스페이스가 기억한 기준 커밋에서 시작하고 뷰가 새 데이터에서 그 커밋을 다시 찾는다
  const listMode = isListModeQuery(s.graphQuery);
  const [mount, setMount] = useState<LogMount>(() => ({ session: s.id, listMode, epoch: 0 }));
  const nextMount = nextLogMount(mount, { session: s.id, listMode });
  if (nextMount !== mount) {
    setMount(nextMount);
  }
  const mountEpoch = nextMount.epoch;
  // 목록 모드인데 옛 그래프 데이터(레인이 있는 행·선)를 그린 마운트의 차례 (그 뒤 새 데이터를 그리면 다시 마운트한다)
  const staleMount = useRef<number | null>(null);
  // 우클릭한 행의 데이터를 찾기 위해 최근 슬라이스의 행을 oid 로 기억한다
  const rowsByOid = useRef(new Map<string, GraphRow>());
  const wantAvatars = s.graphColumns.avatar ?? false;
  const onRowsRendered = useCallback(
    (rows: readonly (GraphRow | undefined)[]) => {
      const map = rowsByOid.current;
      map.clear();
      for (const r of rows) {
        if (r) {
          map.set(r.oid, r);
        }
      }
      // 목록 모드: 이 마운트가 옛 그래프 데이터를 그렸다가 새 데이터를 그리면 넓어진 그래프 열을 줄이도록 다시 마운트한다
      if (listMode && cache) {
        const shown = rows.flatMap((r) => (r ? [r.row] : []));
        const segments =
          shown.length > 0 ? cache.slice(Math.min(...shown), Math.max(...shown) + 1).segments : [];
        const verdict = listRowsVerdict({ rows, segments });
        if (verdict === 'stale') {
          staleMount.current = mountEpoch;
        } else if (verdict === 'fresh' && staleMount.current === mountEpoch) {
          staleMount.current = null;
          setMount((m) => (m.epoch === mountEpoch ? { ...m, epoch: m.epoch + 1 } : m));
        }
      }
      // 보이는 행의 아바타를 미리 받는다 (GRAPH-11)
      if (wantAvatars) {
        s.requestAvatars(rows.map((r) => r?.authorEmail));
      }
    },
    [wantAvatars, s.requestAvatars, listMode, mountEpoch, cache],
  );
  const avatarOf = useCallback((email: string) => s.avatars[email], [s.avatars]);
  // 필터 바는 세션의 질의·보기 설정만 본다: 그래프 행 선택 등으로 이 칸이 다시 그려질 때 함께 그려지지 않게 같은 요소를 둔다
  const filterBar = useMemo(() => <RepoLogFilter />, []);

  if (activeSessionId === null || !cache) {
    return <div className={styles.empty}>{S.panel.graphEmpty}</div>;
  }
  const hasChanges =
    s.summary.staged + s.summary.unstaged + s.summary.untracked + s.summary.conflicted > 0;
  /** WIP 행 활성화 (클릭·WIP 행을 고른 채 Enter): 고르고 Commit 도구 창의 변경 탭을 열어 포커스한다 */
  const activateWip = () => {
    s.selectWip();
    showCommitChanges({ revealCommitChanges, setDockMaximized });
  };
  /**
   * 로그의 키 중 그래프 뷰가 모르는 WIP 행의 몫 (W27, 그래프 뷰보다 먼저 받아 뷰의 이동을 막는다): 첫 commit 행에서 ↑ =
   * WIP 행 고르기(고르기만 — 도구 창은 그대로), WIP 행에서 ↑ = 그대로(뷰는 고른 commit 이 없으면 ↑ 에도 첫 행을 고른다),
   * commit 행이 없으면(필터 결과 0) 행 이동 키 = WIP 행. 다른 워크트리의 WIP 행은 고르지 않는다 (링크 행이다)
   */
  const onLogKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const grid = e.target as HTMLElement;
    if (!hasChanges || grid.getAttribute('role') !== 'grid' || hasModifier(e)) {
      return;
    }
    const onlyWip = s.totalRows === 0 && ROW_KEYS.has(e.key);
    const firstOid = cache.slice(0, 1).rows[0]?.oid;
    const fromTop =
      e.key === 'ArrowUp' &&
      (s.wipSelected || (firstOid !== undefined && s.selectedCommit === firstOid));
    if (!onlyWip && !fromTop) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!s.wipSelected) {
      s.selectWip();
      revealWipRow(grid);
    }
  };
  /** 로그의 Enter: WIP 행을 골랐으면 활성화, 아니면 상세 칸으로 포커스 (폴더 탭과 같은 키) */
  const onLogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isLogEnter(e)) {
      return;
    }
    e.preventDefault();
    if (s.wipSelected && hasChanges) {
      activateWip();
    } else {
      focusPanel('git-detail');
    }
  };
  const query = s.graphQuery;
  const opening = s.loadState === 'opening';
  const failed = s.loadState === 'error';
  const empty = !opening && !failed && isGraphEmpty({ ...s, hasChanges, query });
  const zeroRows = s.totalRows === 0 && s.loadState === 'complete';
  const noMatch = zeroRows && !hasChanges;
  const filtered = hasConditions(query);
  // 읽는 중·실패·빈 저장소에도 필터 바는 보인다 (조건을 풀 수 있게). 안내·찾기 줄은 그래프를 보일 때만 (지금까지와 같다)
  const live = !opening && !failed && !empty;
  /** 건 조건의 요약 (결과 없음 상태·안내 줄) */
  const conditions = () => {
    const authorList = s.graphAuthors?.authors ?? [];
    return conditionSummary(query, {
      now: new Date(),
      authorLabel: (email) =>
        authorList.find((a) => a.email.toLowerCase() === email.toLowerCase())?.name ?? email,
      pathLabel: (path) => describeScopedPath(path, s.moduleScope, s.modules).label,
    }).join(' · ');
  };
  /** "필터 지우기" = 필터 바의 "모두 지우기" (조건·경로를 지우고 보기 옵션은 남긴다) */
  const clearFilters = () => void s.setGraphQuery(clearedQuery(query));
  let body: ReactNode;
  if (opening) {
    body = <div className={styles.empty}>{S.panel.graphLoading}</div>;
  } else if (failed) {
    body = <div className={styles.error}>{s.error ?? S.error.unknown}</div>;
  } else if (empty) {
    body = <div className={styles.empty}>{S.panel.graphNoCommits}</div>;
  } else if (noMatch && filtered) {
    // 필터 결과 없음 (LG-11): 폴더와 같다 — 문구, 건 조건, "필터 지우기"
    body = (
      <div className={styles.state}>
        <span>{S.folder.timeline.noMatch}</span>
        <span className={styles.conditions}>{conditions()}</span>
        <Button disabled={s.busy} onClick={clearFilters}>
          {S.folder.timeline.clearFilters}
        </Button>
      </div>
    );
  } else if (noMatch) {
    // 조건은 없고 보기 옵션(첫 부모만·원격 숨기기 등)만으로 0행: 옛 안내 그대로 (옵션은 바로 위 보기 옵션 메뉴에 있다)
    body = <div className={styles.empty}>{S.panel.graphNoMatch}</div>;
  } else {
    // 조건에 맞는 커밋이 없는데 작업 트리 변경(WIP 행)이 있으면 로그는 그 행만 보인다 (WIP 행은 Commit 도구 창의 입구라
    // 남긴다): 결과 없음은 로그 위 한 줄로 알린다
    const notice =
      zeroRows && hasChanges && filtered ? (
        <div className={styles.notice} role="status">
          <span className={styles.noticeText} title={conditions()}>
            {S.folder.timeline.noMatch} · {conditions()}
          </span>
          <button
            type="button"
            className={styles.noticeAction}
            disabled={s.busy}
            onClick={clearFilters}
          >
            {S.folder.timeline.clearFilters}
          </button>
        </div>
      ) : null;
    body = (
      <>
        {notice}
        <ContextMenuArea<GraphRow>
          className={styles.menuArea}
          resolveTarget={(e) => {
            const el = (e.target as HTMLElement | null)?.closest('[data-oid]');
            const oid = el?.getAttribute('data-oid');
            return oid ? (rowsByOid.current.get(oid) ?? null) : null;
          }}
          items={(row) => graphMenuItems(row, s, dialogs)}
        >
          <GraphView
            key={`${s.id}:${mountEpoch}`}
            cache={cache}
            totalRows={s.totalRows}
            resolveRow={s.resolveRow}
            initialAnchor={anchor?.recall() ?? null}
            onAnchorChange={anchor?.remember}
            wipRow={hasChanges ? s.summary : null}
            wipSelected={s.wipSelected}
            onSelectWip={activateWip}
            selectedOid={s.selectedCommit}
            onSelectRow={(row) => s.selectCommit(row.oid)}
            extraWips={extraWips}
            onSelectExtraWip={(w) => void openRepositoryAt(w.key)}
            onDropRef={onDropRef}
            highlightRows={highlight}
            scrollToRow={s.scrollToRow}
            onScrolledTo={s.consumeScroll}
            onRowsRendered={onRowsRendered}
            columns={s.graphColumns}
            avatarOf={wantAvatars ? avatarOf : undefined}
            rangeRows={rangeRows}
            onSelectRange={(row) => void s.selectRange(row)}
            dimRow={dimRow}
          />
        </ContextMenuArea>
      </>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 로그(grid)에서 올라온 키를 받는다 (W27 — WIP 행·Enter)
    <div className={styles.pane} onKeyDownCapture={onLogKeyDownCapture} onKeyDown={onLogKeyDown}>
      {live ? <CommitGraphBanner /> : null}
      {live ? <PerfBanner /> : null}
      {filterBar}
      {live && s.searchOpen ? <GraphSearch /> : null}
      {body}
      {dialogs.element}
    </div>
  );
}
