import { useElementWidth } from '@mgit/ui';
import { type FocusEvent, type KeyboardEvent, type ReactNode, useCallback, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { readPref, writePref } from '../store/prefs';
import styles from './GitLogSplit.module.css';
import { type SideSplit, useSideSplit } from './use-side-split';

/**
 * 로그 탭의 가로 분할 (왼쪽 칸 | 나머지). 저장 키는 `react-resizable-panels:git-log` (앱 전역 1벌 — 폴더 탭과 저장소
 * 탭이 함께 쓴다, W21). 나머지 칸 안에 (로그 | 상세) 분할이 따로 있다 (`GIT_LOG_DETAIL_SPLIT`) — 이 분할의 패널 id 는
 * W3 그대로라 W8 이전에 저장된 크기도 그대로 쓰인다
 */
export const GIT_LOG_SPLIT: SideSplit = {
  layoutId: 'git-log',
  sideId: 'gitlog-branches',
  mainId: 'gitlog-commits',
  defaultPercent: 20,
};

/**
 * 로그 | 상세 분할 (W8). 저장 키는 `react-resizable-panels:git-log-detail` (앱 전역 1벌).
 * 상세 칸의 기본 크기는 이 분할 안의 비율이다: Git 도구 창 전체의 25% 가 되게 잡는다
 * (왼쪽 칸 기본 20% 를 뺀 80% 안에서 31.25%)
 */
const GIT_LOG_DETAIL_SPLIT = {
  layoutId: 'git-log-detail',
  logId: 'gitlog-graph',
  detailId: 'gitlog-detail',
  detailDefault: '31.25%',
} as const;

/** 왼쪽 칸·로그·상세 칸의 최소 폭 (px). 160 + 360 + 220 이 최소 창(Git 도구 창 924px)에 들어간다 */
const SIDE_MIN_PX = 160;
const LOG_MIN_PX = 360;
const DETAIL_MIN_PX = 220;
/** 분할선 폭. 라이브러리는 분할선을 뺀 폭을 패널끼리 나누므로 바깥 칸의 최소 폭에 더한다 */
const SEPARATOR_PX = 1;
/** 왼쪽 칸 오른쪽 칸(로그 + 상세)의 최소 폭 */
const COMMITS_MIN_PX = LOG_MIN_PX + SEPARATOR_PX + DETAIL_MIN_PX;

/** 왼쪽 칸을 펼쳐 둘지 (사용자의 선택, 앱 전역 1벌 — 폴더 탭·저장소 탭 공용). 값은 `{ open }` */
const PREF_BRANCHES = 'mgit.gitLogBranches';

/** Git 도구 창의 폭이 이보다 좁으면 왼쪽 칸을 자동으로 접는다 (WS-06) */
export const BRANCHES_MIN_TOOLWINDOW_WIDTH = 760;

/** 폭이 좁아 왼쪽 칸을 자동으로 접어야 하는지. 아직 재지 못한 폭(0)으로는 접지 않는다 */
export function isTooNarrowForBranches(toolWindowWidth: number): boolean {
  return toolWindowWidth > 0 && toolWindowWidth < BRANCHES_MIN_TOOLWINDOW_WIDTH;
}

/**
 * 왼쪽 칸이 접혀 있어야 하는지 (WS-06): 사용자가 접었거나, Git 도구 창이 좁아 자동으로 접는 경우다.
 * 자동 접힘은 사용자의 선택(`open`)을 바꾸지 않으므로, 폭이 다시 넓어지면 펼쳐 둔 칸은 돌아오고
 * 사용자가 접어 둔 칸은 접힌 채로 남는다
 */
export function branchesCollapsed(open: boolean, toolWindowWidth: number): boolean {
  return !open || isTooNarrowForBranches(toolWindowWidth);
}

/** 로그 탭 왼쪽 칸의 펼침 상태 (`useGitLogSide`) */
export interface GitLogSide {
  /** 폭을 잴 요소 (로그 탭 전체). `GitLogSplit` 이 바깥 칸에 붙인다 */
  measureRef: (el: HTMLElement | null) => void;
  /** 사용자의 선택 (저장된다) */
  open: boolean;
  /** 지금 접혀 있는지 (사용자의 선택 또는 좁은 폭) */
  collapsed: boolean;
  /** 폭이 좁아 펼 수 없는지 */
  tooNarrow: boolean;
  /** 펼치거나 접고 선택을 저장한다 */
  setOpen: (open: boolean) => void;
}

/**
 * 로그 탭 왼쪽 칸의 펼침 상태 (WS-06): 사용자의 선택(앱 전역 1벌 저장)과 로그 탭의 폭으로 접힘을 정한다. 세로 툴바의
 * 접기 단추와 분할이 같은 값을 쓴다
 */
export function useGitLogSide(): GitLogSide {
  const [open, setOpenState] = useState(
    () => readPref(PREF_BRANCHES, { open: true }).open !== false,
  );
  const [measureRef, width] = useElementWidth();
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    writePref(PREF_BRANCHES, { open: next });
  }, []);
  return {
    measureRef,
    open,
    collapsed: branchesCollapsed(open, width),
    tooNarrow: isTooNarrowForBranches(width),
    setOpen,
  };
}

export interface GitLogSplitProps {
  side: GitLogSide;
  /** 세로 툴바. 접히는 칸 밖이라 늘 보인다 */
  toolbar: ReactNode;
  /** 왼쪽 칸의 내용 (영역 `git-branches` — 폴더 탭은 브랜치 트리, 저장소 탭은 W22 전까지 옛 사이드바) */
  branches: ReactNode;
  /** 가운데 칸의 내용 (영역 `git-log`) */
  log: ReactNode;
  /** 가운데 칸 안에서 올라온 키 (폴더 탭: 로그의 Enter → 상세. 저장소 탭은 `GraphPane` 이 받는다) */
  onLogKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** 오른쪽 칸. 자기 영역(`data-panel="git-detail"`)을 스스로 그린다 */
  detail: ReactNode;
  /** 분할선의 이름 (보조 기술) */
  resizeBranchesLabel: string;
  resizeDetailLabel: string;
  /** 분할 뒤에 붙일 것 (대화상자 등) */
  children?: ReactNode;
}

/**
 * 로그(grid)에서 누른 맨 Enter 인지 (W19 ③ 폴더, W27 저장소 — 두 탭의 "로그 → 상세" 키). 로그의 입력란·행 안 요소와
 * ⌘·Ctrl·⌥ 조합은 아니다
 */
export function isLogEnter(e: KeyboardEvent<HTMLElement>): boolean {
  return (
    e.key === 'Enter' &&
    (e.target as HTMLElement).getAttribute('role') === 'grid' &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  );
}

/**
 * 로그의 행이 포커스를 받으면(마우스로 누르면 tabIndex −1 인 행이 포커스를 받는다) 로그(grid)로 돌린다 (W27). 로그는 표가
 * 포커스를 쥐고 고른 행을 `aria-activedescendant` 로 알리는 방식이라(W19 ③), 행을 누른 뒤에도 Enter·⇧F10·PageDown 이
 * 키보드로 고른 때와 같게 동작한다 (행에 포커스가 남으면 Enter 가 상세로 가지 않고, 가상 스크롤로 행이 빠지면 포커스를
 * 잃는다)
 */
function keepLogFocusOnGrid(e: FocusEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  if (target.getAttribute('role') !== 'row') {
    return;
  }
  target.closest<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
}

/**
 * Git 도구 창 로그 탭의 틀 (폴더 탭 W3·W5·W8, 저장소 탭 W21): 세로 툴바 + [왼쪽 칸 | 로그 | 상세]. 칸 사이는 끌어
 * 조절하고 크기는 앱 전역 1벌로 저장한다. 왼쪽 칸은 항상 렌더하고 접기만 한다(접힌 동안 `inert`). 내용은 슬롯으로만
 * 받는다 — 칸마다 `min-height: 0`·`height: 100%` 를 고정해 안의 그래프·트리가 높이 0 이 되지 않게 한다
 */
export function GitLogSplit({
  side,
  toolbar,
  branches,
  log,
  onLogKeyDown,
  detail,
  resizeBranchesLabel,
  resizeDetailLabel,
  children,
}: GitLogSplitProps) {
  const { setOpen, collapsed } = side;
  const collapse = useCallback(() => setOpen(false), [setOpen]);
  const { groupRef, defaultLayout, onLayoutChanged } = useSideSplit(
    GIT_LOG_SPLIT,
    collapsed,
    collapse,
  );
  const detailSplit = useDefaultLayout({ id: GIT_LOG_DETAIL_SPLIT.layoutId });
  return (
    <div className={styles.timeline} ref={side.measureRef}>
      {toolbar}
      <div className={styles.split}>
        <Group
          orientation="horizontal"
          groupRef={groupRef}
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel
            id={GIT_LOG_SPLIT.sideId}
            defaultSize={`${GIT_LOG_SPLIT.defaultPercent}%`}
            minSize={`${SIDE_MIN_PX}px`}
            collapsible
            style={{ overflow: 'hidden' }}
          >
            {/* 접힌 동안에는 폭 0 으로 DOM 에 남으므로 포커스·보조 기술에서 뺀다 */}
            <aside
              className={styles.branches}
              tabIndex={-1}
              data-panel="git-branches"
              inert={collapsed}
            >
              {branches}
            </aside>
          </Panel>
          {/* 접힌 동안에는 끌 수 없다 (다시 펴는 것은 세로 툴바의 버튼으로) */}
          <Separator
            className={styles.separator}
            disabled={collapsed}
            aria-label={resizeBranchesLabel}
          />
          <Panel
            id={GIT_LOG_SPLIT.mainId}
            minSize={`${COMMITS_MIN_PX}px`}
            style={{ overflow: 'hidden' }}
          >
            <Group
              orientation="horizontal"
              defaultLayout={detailSplit.defaultLayout}
              onLayoutChanged={detailSplit.onLayoutChanged}
            >
              <Panel
                id={GIT_LOG_DETAIL_SPLIT.logId}
                minSize={`${LOG_MIN_PX}px`}
                style={{ overflow: 'hidden' }}
              >
                {/* biome-ignore lint/a11y/noStaticElementInteractions: 로그(grid)에서 올라온 키를 받는다 */}
                <div
                  className={styles.graph}
                  tabIndex={-1}
                  data-panel="git-log"
                  onKeyDown={onLogKeyDown}
                  onFocus={keepLogFocusOnGrid}
                >
                  {log}
                </div>
              </Panel>
              <Separator className={styles.separator} aria-label={resizeDetailLabel} />
              <Panel
                id={GIT_LOG_DETAIL_SPLIT.detailId}
                defaultSize={GIT_LOG_DETAIL_SPLIT.detailDefault}
                minSize={`${DETAIL_MIN_PX}px`}
                style={{ overflow: 'hidden' }}
              >
                {detail}
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
      {children}
    </div>
  );
}
