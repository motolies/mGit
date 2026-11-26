import type { GraphRow } from '@mgit/ipc';
import { formatCommitDate, formatDateTime, repositoryColor, S, shortHash } from '@mgit/ui';
import type { CSSProperties, HTMLAttributes } from 'react';
import styles from './GraphRow.module.css';
import { RefLabels } from './RefLabels';
import { REF_DRAG_TYPE } from './ref-drag';
import { DEFAULT_REF_LABEL_BUDGET, refLabelItems } from './ref-labels';
import { REPO_STRIP_WIDTH } from './repo-strip';

/** 표시할 열 (GRAPH-12). 그래프·메시지는 항상 보인다 */
export interface GraphColumns {
  author: boolean;
  date: boolean;
  hash: boolean;
  /** 작성자 아바타 (GRAPH-11) */
  avatar?: boolean;
  /** 저장소 띠 열 (통합 타임라인 MR-12). 그래프 앞에 놓인다 */
  repo?: boolean;
  /** 저장소 이름 열의 사용자 지정 폭. */
  repoWidth?: number;
}

export const DEFAULT_GRAPH_COLUMNS: GraphColumns = {
  author: true,
  date: true,
  hash: true,
  avatar: false,
};

/** 이메일 → 아바타 data URI. null 은 없음, undefined 는 아직 모름 */
export type AvatarLookup = (email: string) => string | null | undefined;

/** 행의 저장소 이름·색 (타임라인). 없으면 undefined */
export type RepoLookup = (row: GraphRow) => { name: string; color: number } | undefined;

/** 클릭 수정키 (⇧ 는 범위 선택, GRAPH-10) */
export interface SelectModifiers {
  shiftKey: boolean;
}

// 열의 폭 (px). 행의 grid 와 캔버스 위치·라벨 예산 계산이 같은 값을 쓰도록 여기서만 정한다.
/** 열 사이 간격 */
const COLUMN_GAP = 8;
/** 행의 오른쪽 여백 */
const ROW_PADDING_RIGHT = 8;
/** 제목 칸의 최소 폭. 좁은 창에서는 제목을 지키고 작성자 칸부터 줄인다 */
const SUBJECT_MIN_WIDTH = 220;
const AVATAR_WIDTH = 24;
/** 한글 이름 세 글자가 잘리지 않는 폭. 창의 최소 크기(960×600)에서 세로 스크롤바가 자리를 차지해도 모든 칸이 들어가게 잡았다 */
const AUTHOR_MIN_WIDTH = 44;
const AUTHOR_MAX_WIDTH = 120;
/** "2026. 11. 11. 오후 12:50" 이 잘리지 않는 폭 (12px 고정폭 숫자로 139px) */
const DATE_WIDTH = 142;
/** 해시 8자 (12px 고정폭 글꼴로 58px) */
const HASH_WIDTH = 60;

/** 저장소 열의 폭은 잘못된 저장 설정을 제외하고 같은 범위로 제한한다. */
export function repoColumnWidth(columns: GraphColumns): number {
  return typeof columns.repoWidth === 'number' && Number.isFinite(columns.repoWidth)
    ? Math.max(80, Math.min(600, columns.repoWidth))
    : REPO_STRIP_WIDTH;
}

/**
 * 열 설정에 맞는 grid 템플릿 (LG-01): 저장소 띠 → 그래프 → 제목 → 아바타 → 작성자 → 날짜 → 해시.
 * 제목은 남는 폭을 다 쓰되 최소 폭을 지키고, 작성자는 최대 폭까지만 늘어난다
 */
export function gridTemplate(columns: GraphColumns): string {
  const parts: string[] = [];
  if (columns.repo) {
    parts.push(`${repoColumnWidth(columns)}px`);
  }
  parts.push('var(--graph-col, 60px)');
  parts.push(`minmax(${SUBJECT_MIN_WIDTH}px, 1fr)`);
  if (columns.avatar) {
    parts.push(`${AVATAR_WIDTH}px`);
  }
  if (columns.author) {
    parts.push(`minmax(${AUTHOR_MIN_WIDTH}px, ${AUTHOR_MAX_WIDTH}px)`);
  }
  if (columns.date) {
    parts.push(`${DATE_WIDTH}px`);
  }
  if (columns.hash) {
    parts.push(`${HASH_WIDTH}px`);
  }
  return parts.join(' ');
}

/**
 * 그래프 열의 왼쪽 위치 (px). 저장소 띠가 있으면 그 폭과 간격만큼 밀린다.
 * 캔버스 오버레이가 이 값만큼 옮겨 앉으므로 레인 좌표 계산은 띠를 모른다
 */
export function graphColumnLeft(columns: GraphColumns): number {
  return columns.repo ? repoColumnWidth(columns) + COLUMN_GAP : 0;
}

/** 제목·작성자 칸을 뺀 나머지(폭이 고정된 칸, 칸 사이 간격, 오른쪽 여백)가 차지하는 폭 (px) */
function reservedWidth(columns: GraphColumns, graphColumnWidth: number): number {
  const fixed = [
    columns.repo ? repoColumnWidth(columns) : null,
    graphColumnWidth,
    columns.avatar ? AVATAR_WIDTH : null,
    columns.date ? DATE_WIDTH : null,
    columns.hash ? HASH_WIDTH : null,
  ].filter((w) => w !== null);
  // 제목 칸과 (있다면) 작성자 칸이 고정 칸 뒤에 더해진다
  const tracks = fixed.length + 1 + (columns.author ? 1 : 0);
  return fixed.reduce((sum, w) => sum + w, 0) + (tracks - 1) * COLUMN_GAP + ROW_PADDING_RIGHT;
}

/**
 * 행 폭에서 제목 칸이 차지하는 폭 (px). `gridTemplate` 의 배분을 그대로 따른다: 고정 칸을 뺀 나머지에서
 * 작성자 칸이 최대 폭까지 먼저 가져가고 제목이 그 나머지를 쓴다 (최소 폭 아래로는 내려가지 않는다)
 */
export function subjectColumnWidth(
  columns: GraphColumns,
  graphColumnWidth: number,
  rowWidth: number,
): number {
  const free = rowWidth - reservedWidth(columns, graphColumnWidth);
  return Math.max(SUBJECT_MIN_WIDTH, free - (columns.author ? AUTHOR_MAX_WIDTH : 0));
}

/** 좁을 때 빼는 칸의 순서: 덜 중요한 것부터 */
const DROP_ORDER = ['hash', 'date', 'author', 'avatar'] as const;

/**
 * 행 폭에 맞는 열 설정. 제목 칸의 최소 폭을 지키면 다 들어가지 않을 때, 칸이 반쯤 잘려 보이지 않게
 * 덜 중요한 칸부터 통째로 뺀다 (해시 → 날짜 → 작성자 → 아바타). 저장소 띠와 그래프는 빼지 않는다.
 * 폭을 아직 모르면(0 이하) 설정 그대로다
 */
export function fitColumns(
  columns: GraphColumns,
  graphColumnWidth: number,
  rowWidth: number,
): GraphColumns {
  if (rowWidth <= 0) {
    return columns;
  }
  let fitted = columns;
  for (const key of DROP_ORDER) {
    const needed =
      reservedWidth(fitted, graphColumnWidth) +
      SUBJECT_MIN_WIDTH +
      (fitted.author ? AUTHOR_MIN_WIDTH : 0);
    if (needed <= rowWidth) {
      break;
    }
    if (fitted[key]) {
      fitted = { ...fitted, [key]: false };
    }
  }
  return fitted;
}

/** 가상 스크롤 행(커밋·WIP 공용)의 위치와 열 배치 */
export function rowStyle(
  columns: GraphColumns,
  graphColumnWidth: number,
  rowHeight: number,
  offsetTop: number,
): CSSProperties {
  return {
    height: rowHeight,
    transform: `translateY(${offsetTop}px)`,
    gridTemplateColumns: gridTemplate(columns),
    columnGap: COLUMN_GAP,
    paddingRight: ROW_PADDING_RIGHT,
    '--graph-col': `${graphColumnWidth}px`,
  } as CSSProperties;
}

export interface GraphRowViewProps {
  index: number;
  row: GraphRow | undefined;
  /** 그래프 열 폭 (px). 캔버스가 이 폭을 덮는다 */
  graphColumnWidth: number;
  rowHeight: number;
  /** 가상 스크롤이 준 위치 (translateY) */
  offsetTop: number;
  selected: boolean;
  /** 검색 일치 행 */
  highlighted?: boolean;
  /** 범위 선택에 든 행 (GRAPH-10) */
  inRange?: boolean;
  /** HEAD 에서 닿지 않는 커밋: 글자를 흐리게 */
  dim?: boolean;
  columns?: GraphColumns;
  avatarOf?: AvatarLookup;
  repoOf?: RepoLookup;
  /** 저장소 띠에 이름을 쓸 행인지 (구간의 첫 행·화면 맨 위 행, LG-02) */
  showRepoName?: boolean;
  /** 상대 날짜의 기준 시각 (epoch ms). 뷰가 한 번 정해 모든 행에 같은 값을 준다 */
  now: number;
  /** ref 라벨 영역의 글자 수 예산 */
  labelBudget?: number;
  onSelect?: (row: GraphRow, mods: SelectModifiers) => void;
  /** 브랜치 라벨을 이 행에 놓았을 때 (GRAPH-09) */
  onDropRef?: (refName: string, row: GraphRow) => void;
  /** 행 요소의 DOM id (뷰가 `aria-activedescendant` 로 고른 행을 알린다). 없으면 붙이지 않는다 */
  domId?: string;
  /** 표(grid) 안에서의 행 번호 (`aria-rowindex`, 1부터 — WIP 행을 센다). 없으면 붙이지 않는다 */
  ariaRowIndex?: number;
}

/**
 * DOM 텍스트 행 (LG-01): [저장소 띠][그래프 여백][제목 … ref 라벨][작성자][날짜][해시].
 * 미로딩 행은 스켈레톤. 보조 기술에는 표(grid)의 행 하나로 알린다 — 칸마다 gridcell, 그래프 여백은 장식이다
 */
export function GraphRowView({
  index,
  row,
  graphColumnWidth,
  rowHeight,
  offsetTop,
  selected,
  highlighted,
  inRange,
  dim,
  columns = DEFAULT_GRAPH_COLUMNS,
  avatarOf,
  repoOf,
  showRepoName,
  now,
  labelBudget = DEFAULT_REF_LABEL_BUDGET,
  onSelect,
  onDropRef,
  domId,
  ariaRowIndex,
}: GraphRowViewProps) {
  const style = rowStyle(columns, graphColumnWidth, rowHeight, offsetTop);

  if (!row) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 둔다
      // biome-ignore lint/a11y/useFocusableInteractive: 읽는 중인 자리 표시 행이다 (포커스는 뷰가 받는다)
      <div
        className={styles.row}
        style={style}
        data-row={index}
        role="row"
        aria-rowindex={ariaRowIndex}
        aria-busy="true"
      >
        {columns.repo ? <span className={styles.repo} aria-hidden="true" /> : null}
        <span className={styles.graph} aria-hidden="true" />
        <GridCell className={styles.skeleton} />
        {columns.avatar ? <span className={styles.avatar} aria-hidden="true" /> : null}
        {columns.author ? <span className={styles.skeletonShort} aria-hidden="true" /> : null}
        {columns.date ? <span className={styles.skeletonShort} aria-hidden="true" /> : null}
        {columns.hash ? <span className={styles.skeletonShort} aria-hidden="true" /> : null}
      </div>
    );
  }

  const className = [
    styles.row,
    selected ? styles.selected : '',
    highlighted ? styles.highlighted : '',
    inRange ? styles.inRange : '',
  ]
    .filter(Boolean)
    .join(' ');
  const repo = columns.repo ? repoOf?.(row) : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행은 grid 레이아웃이 필요해 div 로 둔다
    <div
      className={className}
      style={style}
      data-row={index}
      data-oid={row.oid}
      data-dim={dim ? 'true' : undefined}
      role="row"
      id={domId}
      aria-rowindex={ariaRowIndex}
      aria-selected={selected}
      tabIndex={-1}
      onClick={(e) => onSelect?.(row, { shiftKey: e.shiftKey })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          onSelect?.(row, { shiftKey: e.shiftKey });
        }
      }}
      onDragOver={(e) => {
        if (onDropRef && e.dataTransfer.types.includes(REF_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'link';
        }
      }}
      onDrop={(e) => {
        const name = e.dataTransfer.getData(REF_DRAG_TYPE);
        if (onDropRef && name) {
          e.preventDefault();
          onDropRef(name, row);
        }
      }}
    >
      {columns.repo ? (
        // 색은 데이터가 준 저장소 색 번호의 레인 토큰 하나만 쓴다 (LF-09). 이름은 구간마다 한 번만 쓰고,
        // 어느 행에서든 툴팁으로는 읽을 수 있다. 보조 기술에는 모든 행에서 저장소 이름을 읽힌다
        <GridCell
          className={repo ? `${styles.repo} ${styles.repoTinted}` : styles.repo}
          title={repo?.name}
          aria-label={repo?.name}
          style={
            repo ? ({ '--repo-color': repositoryColor(repo.color) } as CSSProperties) : undefined
          }
        >
          {repo && showRepoName ? <span className={styles.repoName}>{repo.name}</span> : null}
        </GridCell>
      ) : null}
      <span className={styles.graph} aria-hidden="true" />
      <GridCell className={styles.message}>
        <span className={styles.subject} title={row.subject}>
          {row.subject}
        </span>
        <RefLabels items={refLabelItems(row.refs, row.isHead)} budget={labelBudget} />
      </GridCell>
      {columns.avatar ? (
        <span className={styles.avatar} title={row.authorEmail} aria-hidden="true">
          {(() => {
            const uri = avatarOf?.(row.authorEmail);
            return uri ? <img src={uri} alt="" /> : row.authorName.trim().charAt(0).toUpperCase();
          })()}
        </span>
      ) : null}
      {columns.author ? (
        <GridCell className={styles.author} title={row.authorEmail}>
          {row.authorName}
        </GridCell>
      ) : null}
      {columns.date ? (
        <GridCell className={styles.date} title={formatDateTime(row.authorTime)}>
          {formatCommitDate(row.authorTime, now, S.date)}
        </GridCell>
      ) : null}
      {columns.hash ? (
        <GridCell className={styles.hash} title={row.oid}>
          {shortHash(row.oid)}
        </GridCell>
      ) : null}
    </div>
  );
}

/**
 * 표(grid) 행의 칸 하나 (W19 ③): 보조 기술에 gridcell 로 알린다. 칸은 포커스를 받지 않는다 — 뷰가 포커스를 받고
 * 행 단위로 옮긴다 (`aria-activedescendant`)
 */
export function GridCell(props: HTMLAttributes<HTMLSpanElement>) {
  // biome-ignore lint/a11y/useSemanticElements: 가상 스크롤 행의 칸은 grid 배치(CSS)의 span 이라 <td> 로 둘 수 없다
  // biome-ignore lint/a11y/useFocusableInteractive: 칸은 포커스를 받지 않는다 (행 단위로 옮긴다)
  return <span role="gridcell" {...props} />;
}
