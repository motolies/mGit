import { Icon, S } from '@mgit/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { openContextMenuAt, siblingPositions, treeKeyCommand } from '../../components/tree-keys';
import { useVirtualTree } from '../../components/use-virtual-tree';
import { opBadgeText } from '../project/project-rows';
import type { CommitFileRow, CommitRow } from './commit-tree-model';
import styles from './FolderCommitTree.module.css';

export interface FolderCommitTreeProps {
  /** 그릴 줄 (`commitTreeRows`) */
  rows: readonly CommitRow[];
  /** 체크를 막는 저장소 (그 저장소에 stage·unstage 가 도는 중) */
  busyRepos: ReadonlySet<string>;
  /** "처리 중" 으로 보일 줄 id */
  processing: ReadonlySet<string>;
  /** 모든 체크를 막는다 (일괄 작업·커밋 실행 중) */
  locked: boolean;
  /** 체크를 눌렀다 (클릭·Space). 막힌 줄은 부르지 않는다 */
  onToggleCheck: (row: CommitRow) => void;
  /** 저장소·디렉터리 줄을 펼치거나 접는다 */
  onToggleExpand: (row: CommitRow) => void;
  /** 파일을 연다 (클릭·Enter) */
  onOpen: (row: CommitFileRow) => void;
  /** 줄의 우클릭 메뉴. 빈 목록이면 메뉴를 열지 않는다 */
  menu: (row: CommitRow) => MenuItem[];
  /** 처음 그릴 때의 스크롤 위치 (도구 창을 다시 띄웠을 때) */
  initialScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
  /**
   * 보일 줄 (W19, 작업 띠의 "충돌 해결" → 그 저장소 줄): `seq` 가 바뀔 때마다 그 줄을 고르고 맨 위로 스크롤한 뒤
   * `onRevealed(seq)` 를 부른다
   */
  reveal?: { index: number; seq: number } | null;
  onRevealed?: (seq: number) => void;
}

/** 체크를 누를 수 없는 사유. 누를 수 있으면 null */
function blockedReason(
  row: CommitRow,
  props: Pick<FolderCommitTreeProps, 'busyRepos' | 'locked'>,
): string | null {
  if (row.check === 'conflict') {
    return S.commitTool.conflictFile;
  }
  if (row.check === null) {
    return S.commitTool.conflictOnly;
  }
  if (props.locked) {
    return S.commitTool.committingLock;
  }
  return props.busyRepos.has(row.repoPath) ? S.commitTool.repoBusy : null;
}

/** 줄의 aria-checked 값: 체크 / 빔 / 중간. 충돌은 체크할 수 없는 빔이다 */
function ariaChecked(row: CommitRow): 'true' | 'false' | 'mixed' {
  if (row.check === 'checked') {
    return 'true';
  }
  return row.check === 'mixed' ? 'mixed' : 'false';
}

/**
 * Commit 도구 창 폴더 모드의 변경 트리 (W14): 저장소(색 사각형·이름·브랜치·파일 수) › 폴더(단일 자식 사슬 압축) ›
 * 파일(상태 문자·색). 줄마다 세 상태 체크박스가 있다 — 상태는 행(treeitem)의 `aria-checked`(`mixed` 포함)로 알리고,
 * 상자를 누르거나 Space 를 누르면 `onToggleCheck`. 무엇을 부를지는 컨테이너가 정한다 (스토어를 모른다).
 * 충돌 파일·충돌뿐인 폴더, 처리 중인 저장소, 실행 중에는 상자가 흐려지고 툴팁이 사유를 말한다.
 * 클릭: 파일 = 열기, 저장소·디렉터리 = 펼침 토글. Enter = 열기(디렉터리는 펼침 토글), Space = 체크.
 * 가상 스크롤로 그린다 (변경이 수천 개일 수 있다). 포커스는 트리가 받고 기준 행을 `aria-activedescendant` 로 알린다
 */
export function FolderCommitTree({
  rows,
  busyRepos,
  processing,
  locked,
  onToggleCheck,
  onToggleExpand,
  onOpen,
  menu,
  initialScrollTop,
  onScrollTopChange,
  reveal = null,
  onRevealed,
}: FolderCommitTreeProps) {
  const baseId = useId();
  const treeRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { virtualizer, rowHeight, scrollToRow } = useVirtualTree({
    scrollRef: treeRef,
    count: rows.length,
    keyOf: (index) => rows[index]?.id ?? index,
  });
  const selectedIndex = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
  // 형제 수·순번 (W18 이 넘긴 것): 가상 스크롤로 화면 밖 행이 DOM 에 없어도 "N개 중 M번째"를 알린다
  const positions = useMemo(() => siblingPositions(rows.map((r) => r.parentId)), [rows]);
  const items = virtualizer.getVirtualItems();
  const selectedRendered = items.some((item) => item.index === selectedIndex);
  const rowDomId = (index: number) => `${baseId}-row-${index}`;

  // 처음 그릴 때 기억해 둔 스크롤 위치로 돌아간다
  // biome-ignore lint/correctness/useExhaustiveDependencies: 마운트 때 한 번만 돌린다
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (el && initialScrollTop) {
      el.scrollTop = initialScrollTop;
    }
  }, []);

  // 보이라고 한 줄: 고르고 맨 위로 스크롤한 뒤 알린다 (마운트 직후의 요청도 — 기억한 스크롤 위치보다 뒤에 돈다)
  const revealSeq = reveal?.seq ?? null;
  const revealIndex = reveal?.index ?? -1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 요청(seq)마다 한 번만 돌린다 — 줄 목록이 바뀌어도 다시 돌지 않는다
  useEffect(() => {
    const row = rows[revealIndex];
    if (revealSeq === null || !row) {
      return;
    }
    setSelectedId(row.id);
    virtualizer.scrollToIndex(revealIndex, { align: 'start' });
    onRevealed?.(revealSeq);
  }, [revealSeq, revealIndex]);

  /** 체크를 누른다. 막힌 줄이면 아무것도 하지 않는다 */
  const toggleCheck = (row: CommitRow) => {
    if (blockedReason(row, { busyRepos, locked }) === null) {
      onToggleCheck(row);
    }
  };

  /** 그 행을 고르고 보이게 스크롤한다. 범위를 벗어나면 끝 행에서 멈춘다 */
  const moveTo = (index: number) => {
    const at = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[at];
    if (!row) {
      return;
    }
    setSelectedId(row.id);
    scrollToRow(at);
  };

  /** 행의 "누르기": 파일은 열고, 저장소·디렉터리는 펼침을 뒤집는다 */
  const activate = (row: CommitRow) => {
    if (row.kind === 'file') {
      onOpen(row);
    } else if (row.expandable) {
      onToggleExpand(row);
    }
  };

  /**
   * 트리의 키보드 조작 (공용 규칙 `treeKeyCommand`): ↑↓·Home·End 이동, ←→ 접기·펼치기와 부모·자식 이동, Enter 열기
   * (저장소·디렉터리 행은 펼침 뒤집기), Space 체크, ⇧F10·메뉴 키 우클릭 메뉴
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[selectedIndex];
    const command = treeKeyCommand(e, rows, selectedIndex);
    if (!command) {
      return;
    }
    e.preventDefault();
    switch (command.kind) {
      case 'move':
        moveTo(command.index);
        break;
      case 'expand':
      case 'collapse':
        if (row) {
          onToggleExpand(row);
        }
        break;
      case 'enter':
        if (row) {
          activate(row);
        }
        break;
      case 'space':
        if (row) {
          toggleCheck(row);
        }
        break;
      case 'menu':
        openContextMenuAt(treeRef.current?.querySelector(`[data-row-index="${selectedIndex}"]`));
        break;
    }
  };

  /** 행 클릭: 고르고 누른다. 더블클릭의 두 번째 클릭은 고르기만 한다 (펼침이 두 번 뒤집히지 않게) */
  const onRowClick = (row: CommitRow, e: MouseEvent) => {
    setSelectedId(row.id);
    if (e.detail <= 1) {
      activate(row);
    }
  };

  /** 세 상태 상자. 누르면 체크만 하고 행의 클릭(열기·펼침)으로 번지지 않는다 */
  const renderCheck = (row: CommitRow) => {
    const blocked = blockedReason(row, { busyRepos, locked });
    const state = row.check === 'conflict' || row.check === null ? 'unchecked' : row.check;
    return (
      // 상태는 행의 aria-checked 가 알리고 키보드는 트리의 Space 가 맡는다 (상자는 마우스 대상)
      <span
        className={styles.check}
        data-state={state}
        data-disabled={blocked !== null ? 'true' : undefined}
        data-check="true"
        title={blocked ?? S.commitTool.check[state]}
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          setSelectedId(row.id);
          toggleCheck(row);
        }}
      >
        {state === 'checked' ? <Icon name="checkMark" /> : null}
        {state === 'mixed' ? <Icon name="checkMixed" /> : null}
      </span>
    );
  };

  /** 행의 글자 부분 */
  const renderBody = (row: CommitRow) => {
    switch (row.kind) {
      case 'repo': {
        const { repo } = row;
        const op = opBadgeText(repo.op);
        return (
          <>
            {repo.color === null ? null : (
              <span
                className={styles.swatch}
                style={{ '--repo-color': `var(--graph-lane-${repo.color})` } as CSSProperties}
              />
            )}
            <span className={styles.repoName} title={repo.path}>
              {repo.name}
            </span>
            <span className={styles.branch}>
              {repo.detached || repo.branch === null ? S.status.detached : repo.branch}
            </span>
            {op ? <span className={styles.badge}>{op}</span> : null}
            {repo.error !== null ? (
              <span
                className={styles.warning}
                role="img"
                aria-label={S.commitTool.summaryFailed(repo.error)}
                title={S.commitTool.summaryFailed(repo.error)}
              >
                <Icon name="warning" />
              </span>
            ) : null}
            <span className={styles.muted}>
              {S.commitTool.files(repo.files)}
              {repo.conflicts > 0 ? ` · ${S.commitTool.conflicts(repo.conflicts)}` : ''}
            </span>
          </>
        );
      }
      case 'dir':
        return (
          <>
            <span className={styles.icon}>
              <Icon name="folder" />
            </span>
            <span className={styles.name} title={row.path}>
              {row.name}
            </span>
            <span className={styles.muted}>{S.commitTool.files(row.files)}</span>
          </>
        );
      case 'file': {
        const { entry, mark } = row;
        return (
          <>
            <span className={styles.letter} title={mark.title}>
              {mark.letter}
            </span>
            {row.check === 'conflict' ? (
              <span
                className={styles.warning}
                role="img"
                aria-label={S.commitTool.conflictFile}
                title={S.commitTool.conflictFile}
              >
                <Icon name="warning" />
              </span>
            ) : null}
            <span
              className={styles.name}
              title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
            >
              {row.name}
            </span>
            {entry.origPath ? (
              <span className={styles.muted}>{S.changes.renamedFrom(entry.origPath)}</span>
            ) : null}
          </>
        );
      }
    }
  };

  return (
    <ContextMenuArea<CommitRow>
      className={styles.menuArea}
      resolveTarget={(e) => {
        const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
        const row = el ? rows[Number(el.getAttribute('data-row-index'))] : undefined;
        return row && menu(row).length > 0 ? row : null;
      }}
      items={menu}
    >
      <div
        ref={treeRef}
        className={styles.tree}
        role="tree"
        aria-label={S.commitTool.tree}
        aria-activedescendant={selectedRendered ? rowDomId(selectedIndex) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => onScrollTopChange?.(e.currentTarget.scrollTop)}
      >
        <div
          className={styles.inner}
          role="presentation"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) {
              return null;
            }
            const busy = processing.has(row.id);
            return (
              // 포커스는 트리가 받으므로 행은 포커스 대상이 아니다 (aria-activedescendant)
              // biome-ignore lint/a11y/useFocusableInteractive: 트리가 포커스를 받고 행은 activedescendant 로 알린다
              // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 트리의 onKeyDown 이 맡는다
              <div
                key={item.key}
                id={rowDomId(item.index)}
                className={styles.row}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-setsize={positions[item.index]?.setSize}
                aria-posinset={positions[item.index]?.posInSet}
                aria-selected={row.id === selectedId}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-checked={ariaChecked(row)}
                aria-busy={busy ? true : undefined}
                data-row-index={item.index}
                data-kind={row.kind}
                data-tone={row.kind === 'file' ? row.mark.tone : undefined}
                style={
                  {
                    '--depth': row.depth,
                    height: rowHeight,
                    transform: `translateY(${item.start}px)`,
                  } as CSSProperties
                }
                onClick={(e) => onRowClick(row, e)}
                onContextMenu={() => setSelectedId(row.id)}
              >
                <span className={styles.twisty}>
                  {row.expandable ? (
                    <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} />
                  ) : null}
                </span>
                {renderCheck(row)}
                {renderBody(row)}
                {busy ? <span className={styles.processing}>{S.commitTool.processing}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </ContextMenuArea>
  );
}
