import { S } from '@mgit/ui';
import { DEFAULT_GRAPH_COLUMNS, type GraphColumns, GridCell, rowStyle } from './GraphRow';
import styles from './GraphRow.module.css';

/** WIP 행에 보여 줄 집계 */
export interface WipSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface WipRowViewProps {
  summary: WipSummary;
  /** 다른 워크트리의 WIP 면 그 이름 (branch 또는 폴더) */
  label?: string;
  graphColumnWidth: number;
  rowHeight: number;
  offsetTop: number;
  selected: boolean;
  columns?: GraphColumns;
  onSelect?: () => void;
  /** 행 요소의 DOM id (`aria-activedescendant`). 없으면 붙이지 않는다 */
  domId?: string;
  /** 표(grid) 안에서의 행 번호 (`aria-rowindex`, 1부터). 없으면 붙이지 않는다 */
  ariaRowIndex?: number;
}

/** 작업 트리에 변경이 있을 때 맨 위에 두는 WIP 행 (GRAPH-03). 열 배치는 커밋 행과 같다 */
export function WipRowView({
  summary,
  label,
  graphColumnWidth,
  rowHeight,
  offsetTop,
  selected,
  columns = DEFAULT_GRAPH_COLUMNS,
  onSelect,
  domId,
  ariaRowIndex,
}: WipRowViewProps) {
  const parts: string[] = [];
  if (summary.conflicted > 0) {
    parts.push(S.status.conflicted(summary.conflicted));
  }
  if (summary.staged > 0) {
    parts.push(S.status.staged(summary.staged));
  }
  if (summary.unstaged > 0) {
    parts.push(S.status.unstaged(summary.unstaged));
  }
  if (summary.untracked > 0) {
    parts.push(S.status.untracked(summary.untracked));
  }
  const className = [styles.row, styles.wip, selected ? styles.selected : '']
    .filter(Boolean)
    .join(' ');
  return (
    // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 둔다
    <div
      className={className}
      style={rowStyle(columns, graphColumnWidth, rowHeight, offsetTop)}
      data-row="wip"
      role="row"
      id={domId}
      aria-rowindex={ariaRowIndex}
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          onSelect?.();
        }
      }}
    >
      {columns.repo ? <span className={styles.repo} aria-hidden="true" /> : null}
      <span className={styles.graph} aria-hidden="true" />
      <GridCell className={styles.message}>
        <span className={styles.subject}>{label ? S.changes.wipOf(label) : S.changes.wip}</span>
      </GridCell>
      {columns.avatar ? <span className={styles.avatar} aria-hidden="true" /> : null}
      {columns.author ? <GridCell className={styles.author}>{parts.join(' · ')}</GridCell> : null}
      {columns.date ? <span className={styles.date} aria-hidden="true" /> : null}
      {columns.hash ? <span className={styles.hash} aria-hidden="true" /> : null}
    </div>
  );
}
