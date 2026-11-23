import { Icon, type IconName, isImeKey, S } from '@mgit/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { openContextMenuAt, siblingPositions, treeKeyCommand } from '../../components/tree-keys';
import styles from './BranchTree.module.css';
import {
  type BranchBadge,
  type BranchNodeKind,
  type BranchTrack,
  type BranchTreeExpansion,
  type BranchTreeNode,
  type BranchTreeRow,
  filterBranchTree,
  flattenBranchTree,
} from './branch-tree-model';

export interface BranchTreeProps {
  /** 그릴 트리. 빌더가 만든 순서 그대로 그린다 (정렬은 빌더의 몫) */
  nodes: readonly BranchTreeNode[];
  /** 선택된 것으로 그릴 노드 id. 무엇이 선택인지는 컨테이너가 정한다 */
  selectedIds: readonly string[];
  /** 사용자가 바꾼 펼침 상태. 바깥의 세로 툴바가 모두 펼치기·접기를 하므로 밖에서 받는다 */
  expansion: BranchTreeExpansion;
  onExpansionChange: (next: BranchTreeExpansion) => void;
  /** 잎을 눌렀을 때 (클릭, Space). `additive` 는 ⌘/Ctrl 과 함께 누른 것 */
  onActivate: (node: BranchTreeNode, options: { additive: boolean }) => void;
  /** 잎을 열 때 (더블클릭, Enter) */
  onOpen: (node: BranchTreeNode) => void;
  /** 우클릭 메뉴 항목. 빈 목록을 주면 그 노드에서는 메뉴를 열지 않는다 */
  menu: (node: BranchTreeNode) => MenuItem[];
  /** 행의 별 버튼을 눌렀을 때 */
  onToggleFavorite: (node: BranchTreeNode) => void;
  /** 노드가 하나도 없을 때의 문구 (읽는 중 등). 주지 않으면 "branch 가 없습니다" */
  emptyText?: string;
  /**
   * 검색어를 밖에서 들고 있을 때 (저장소 탭: 로그 탭이 내려갔다 와도 남게, W22). 주지 않으면 트리가 스스로 든다
   * (폴더 탭). 줄 때는 `onSearchChange` 도 함께 준다
   */
  search?: string;
  onSearchChange?: (text: string) => void;
  /** 행 끝에 붙일 단추 (저장소 탭 Worktrees 그룹의 정리·만들기, W22). 주지 않으면 없다 */
  rowActions?: (node: BranchTreeNode) => readonly BranchRowAction[];
}

/**
 * 행 끝의 단추 하나 (옛 사이드바 섹션 머리 단추를 옮긴 자리). 행마다 Tab 정지를 만들지 않으므로 키보드로는 그 행의
 * 우클릭 메뉴가 같은 일을 해야 한다
 */
export interface BranchRowAction {
  key: string;
  icon: IconName;
  /** 단추 이름 (보조 기술) */
  label: string;
  /** 툴팁. 주지 않으면 이름 */
  title?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** 행 단추가 없는 노드의 빈 목록 (매번 새 배열을 만들지 않게) */
const NO_ROW_ACTIONS: readonly BranchRowAction[] = [];

/** 종류별 아이콘. 그룹과 HEAD 행은 아이콘 없이 이름만 쓴다 */
const KIND_ICON: Partial<Record<BranchNodeKind, IconName>> = {
  folder: 'folder',
  local: 'branch',
  remote: 'remote',
  tag: 'tag',
  worktree: 'worktree',
  backup: 'backup',
};

/** 배지 아이콘 */
const BADGE_ICON: Record<BranchBadge['icon'], IconName> = {
  worktree: 'worktree',
  radarOk: 'ok',
  radarConflict: 'warning',
  tagDiffers: 'warning',
};

/** 행 앞 아이콘: 모양과 색조, 설명. 현재 브랜치 > 즐겨찾기 > 종류 순으로 고른다 */
function iconOf(node: BranchTreeNode): { name: IconName; tone: string; title?: string } | null {
  if (node.current === true) {
    return { name: 'head', tone: 'head', title: node.currentTitle ?? S.branches.current };
  }
  if (node.current === 'partial') {
    return {
      name: 'head',
      tone: 'partial',
      title: node.currentTitle ?? S.branches.currentPartial,
    };
  }
  if (node.favorite) {
    return { name: 'star', tone: 'favorite', title: S.branches.favorite };
  }
  const name = KIND_ICON[node.kind];
  return name ? { name, tone: node.kind } : null;
}

/**
 * 업스트림과의 차이 (BT-08): 받을 것 `⇣54`, 보낼 것 `⇡3`, 원격에서 사라졌으면 그 사실.
 * 방향마다 색이 다르지만 화살표 모양으로도 구분된다
 */
function TrackMarks({ track, title }: { track: BranchTrack; title?: string }) {
  return (
    <span className={styles.track} title={title}>
      {track.behind > 0 ? (
        <span data-dir="incoming">{S.branches.incoming(track.behind)}</span>
      ) : null}
      {track.ahead > 0 ? <span data-dir="outgoing">{S.branches.outgoing(track.ahead)}</span> : null}
      {track.gone ? <span data-dir="gone">{S.sidebar.gone}</span> : null}
    </span>
  );
}

/** 행 툴팁: 이름과 회색 글자(잘렸을 때 전체를 보인다), 그 아래 현재 저장소·업스트림 차이·덧붙인 설명 */
function rowTitle(node: BranchTreeNode): string {
  return [
    node.suffix ? `${node.label} ${node.suffix}` : node.label,
    ...(node.currentTitle ? [node.currentTitle] : []),
    ...(node.trackTitle ? [node.trackTitle] : []),
    ...(node.detail ? [node.detail()] : []),
  ].join('\n');
}

/**
 * 덧붙인 설명(`detail`)이 있는 행에 마우스가 올라가면 그때 툴팁을 만들어 넣는다. 이 행들은 키보드 커서 행이 아니면
 * React 가 `title` 을 그리지 않으므로(늦게 만들기) 여기서 직접 넣어도 다음 렌더와 부딪히지 않는다
 */
function fillLazyTitle(el: HTMLElement, node: BranchTreeNode): void {
  el.title = rowTitle(node);
}

/** 키보드 커서가 있는 행: 커서 노드가 보이면 그 행, 아니면 선택된 첫 행. 없으면 -1 */
function cursorIndexOf(
  rows: readonly BranchTreeRow[],
  cursorId: string | null,
  selected: ReadonlySet<string>,
): number {
  const at = cursorId === null ? -1 : rows.findIndex((row) => row.node.id === cursorId);
  return at >= 0 ? at : rows.findIndex((row) => selected.has(row.node.id));
}

/**
 * 브랜치 트리 (BT-01·02·12): 맨 위 검색 입력과 그 아래 트리. 노드와 동작을 모두 props 로 받는다 —
 * 어느 스토어의 데이터인지, 클릭·더블클릭·메뉴가 무슨 뜻인지 모른다 (폴더는 로그 필터, 저장소는 W22 가 정한다).
 * 포커스는 트리 자체가 받고 키보드 커서를 `aria-activedescendant` 로 알린다. 커서(↑↓)와 선택은 따로다:
 * 커서를 옮기는 것만으로는 `onActivate` 를 부르지 않는다 (Space 가 부른다).
 * memo 로 감쌌다: 로그 행을 고르는 등 컨테이너가 다시 그려져도 받은 값이 같으면 트리를 다시 그리지 않는다 (W18 ②·W22 —
 * 컨테이너가 노드 배열과 콜백을 안정하게 넘겨야 효과가 있다)
 */
export const BranchTree = memo(function BranchTree({
  nodes,
  selectedIds,
  expansion,
  onExpansionChange,
  onActivate,
  onOpen,
  menu,
  onToggleFavorite,
  emptyText,
  search: searchProp,
  onSearchChange,
  rowActions,
}: BranchTreeProps) {
  const baseId = useId();
  const treeRef = useRef<HTMLDivElement>(null);
  const [ownSearch, setOwnSearch] = useState('');
  // 밖에서 검색어를 주면 그 값을 쓰고, 아니면 트리가 든다
  const search = searchProp ?? ownSearch;
  const setSearch = (text: string) => {
    if (searchProp === undefined) {
      setOwnSearch(text);
    }
    onSearchChange?.(text);
  };
  const [cursorId, setCursorId] = useState<string | null>(null);
  const searching = search.trim() !== '';
  // 검색 중에는 일치하는 잎과 조상만 남기고 모두 펼친다
  const rows = useMemo(
    () => flattenBranchTree(filterBranchTree(nodes, search), expansion, searching),
    [nodes, search, expansion, searching],
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  // 키 규칙이 보는 행 모양
  const keyRows = useMemo(
    () =>
      rows.map((r) => ({
        id: r.node.id,
        parentId: r.parentId,
        expandable: r.expandable,
        expanded: r.expanded,
      })),
    [rows],
  );
  // 형제 수·순번 (보조 기술의 "N개 중 M번째"): 같은 부모 아래의 차례
  const positions = useMemo(() => siblingPositions(rows.map((r) => r.parentId)), [rows]);
  const cursorIndex = cursorIndexOf(rows, cursorId, selected);
  const rowDomId = (index: number) => `${baseId}-row-${index}`;

  /** 커서를 그 행으로 옮기고 보이게 스크롤한다. 범위를 벗어나면 끝 행에서 멈춘다 */
  const moveCursor = (index: number) => {
    const at = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[at];
    if (!row) {
      return;
    }
    setCursorId(row.node.id);
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${at}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  };

  /** 노드를 펼치거나 접는다. 검색 중에는 모두 펼쳐 보이므로 바꾸지 않는다 */
  const setExpanded = (row: BranchTreeRow, expanded: boolean) => {
    if (!searching) {
      onExpansionChange({ ...expansion, [row.node.id]: expanded });
    }
  };

  /**
   * 트리의 키보드 조작 (공용 규칙 `treeKeyCommand`): ↑↓·Home·End 이동, ←→ 접기·펼치기와 부모·자식 이동(검색 중에는
   * 모두 펼쳐 보이므로 ← 는 부모로만), Enter 열기(더블클릭과 같은 `onOpen` — branch 는 기본 branch 와 함께 그래프 거르기),
   * Space 누르기(클릭과 같은 `onActivate`), ⇧F10·메뉴 키 우클릭 메뉴.
   * 그룹·폴더 행의 Enter·Space 는 펼침을 뒤집는다. ⌘Space 는 선택에 더한다 (클릭의 ⌘ 와 같다)
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[cursorIndex];
    // ⌘/Ctrl Space 는 선택에 더하기다 (공용 규칙은 수정키 조합을 보지 않는다)
    const additive = e.key === ' ' && (e.metaKey || e.ctrlKey);
    const command = additive
      ? row
        ? ({ kind: 'space' } as const)
        : null
      : treeKeyCommand(e, keyRows, cursorIndex, { canCollapse: !searching });
    if (!command) {
      return;
    }
    e.preventDefault();
    switch (command.kind) {
      case 'move':
        moveCursor(command.index);
        break;
      case 'expand':
      case 'collapse':
        if (row) {
          setExpanded(row, command.kind === 'expand');
        }
        break;
      case 'enter':
        if (row?.expandable) {
          setExpanded(row, !row.expanded);
        } else if (row) {
          onOpen(row.node);
        }
        break;
      case 'space':
        if (row?.expandable) {
          setExpanded(row, !row.expanded);
        } else if (row) {
          onActivate(row.node, { additive });
        }
        break;
      case 'menu':
        openContextMenuAt(treeRef.current?.querySelector(`[data-row-index="${cursorIndex}"]`));
        break;
    }
  };

  return (
    <div className={styles.window}>
      <div className={styles.search}>
        <Icon name="search" />
        <input
          type="search"
          className={styles.searchInput}
          value={search}
          placeholder={S.branches.search}
          aria-label={S.branches.search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            // 한글 조합 중의 ↓ 는 후보 이동이다
            if (e.key === 'ArrowDown' && !isImeKey(e)) {
              e.preventDefault();
              moveCursor(0);
              treeRef.current?.focus();
            }
          }}
        />
      </div>
      {rows.length === 0 ? (
        <div className={styles.empty}>
          {nodes.length === 0 ? (emptyText ?? S.branches.empty) : S.branches.noMatch}
        </div>
      ) : null}
      <ContextMenuArea<BranchTreeNode>
        className={styles.menuArea}
        resolveTarget={(e) => {
          const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
          const row = el ? rows[Number(el.getAttribute('data-row-index'))] : undefined;
          return row && menu(row.node).length > 0 ? row.node : null;
        }}
        items={menu}
      >
        <div
          ref={treeRef}
          className={styles.tree}
          role="tree"
          aria-label={S.branches.tree}
          aria-multiselectable="true"
          aria-activedescendant={cursorIndex >= 0 ? rowDomId(cursorIndex) : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {rows.map((row, index) => {
            const { node } = row;
            const icon = iconOf(node);
            const favorite = node.favorite === true;
            // 덧붙인 설명은 툴팁이 필요할 때 만든다: 키보드 커서 행(보조 기술이 설명을 읽는다)만 렌더에서, 나머지는 마우스가
            // 올라갈 때
            const lazyTitle = node.detail !== undefined && index !== cursorIndex;
            return (
              // 포커스는 트리가 받으므로 행은 포커스 대상이 아니다 (aria-activedescendant)
              // biome-ignore lint/a11y/useFocusableInteractive: 트리가 포커스를 받고 행은 activedescendant 로 알린다
              // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 트리의 onKeyDown 이 맡는다
              <div
                key={node.id}
                id={rowDomId(index)}
                className={styles.row}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-setsize={positions[index]?.setSize}
                aria-posinset={positions[index]?.posInSet}
                aria-selected={selected.has(node.id)}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-current={node.current === true ? 'true' : undefined}
                data-row-index={index}
                data-node-id={node.id}
                data-leaf={row.expandable ? 'false' : 'true'}
                data-cursor={index === cursorIndex ? 'true' : 'false'}
                style={{ '--depth': row.depth } as CSSProperties}
                title={lazyTitle ? undefined : rowTitle(node)}
                onMouseEnter={node.detail ? (e) => fillLazyTitle(e.currentTarget, node) : undefined}
                onClick={(e) => {
                  setCursorId(node.id);
                  if (row.expandable) {
                    setExpanded(row, !row.expanded);
                  } else {
                    onActivate(node, { additive: e.metaKey || e.ctrlKey });
                  }
                }}
                onDoubleClick={() => {
                  if (!row.expandable) {
                    onOpen(node);
                  }
                }}
                onContextMenu={() => setCursorId(node.id)}
              >
                {row.expandable ? (
                  <span className={styles.twisty}>
                    <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} />
                  </span>
                ) : null}
                {icon ? (
                  <span className={styles.icon} data-tone={icon.tone} title={icon.title}>
                    <Icon name={icon.name} />
                  </span>
                ) : null}
                <span className={styles.label}>{node.label}</span>
                {node.count !== undefined ? (
                  <span className={styles.count}>{node.count}</span>
                ) : null}
                {node.track ? <TrackMarks track={node.track} title={node.trackTitle} /> : null}
                {node.suffix ? <span className={styles.suffix}>{node.suffix}</span> : null}
                {(node.badges ?? []).map((badge) => (
                  <span
                    key={`${badge.icon}:${badge.title}`}
                    className={styles.badge}
                    data-icon={badge.icon}
                    title={badge.title}
                  >
                    <Icon name={BADGE_ICON[badge.icon]} />
                    {badge.text}
                  </span>
                ))}
                {(rowActions?.(node) ?? NO_ROW_ACTIONS).map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={styles.rowAction}
                    // 행마다 탭 정지를 만들지 않는다. 키보드로는 그 행의 우클릭 메뉴가 같은 일을 한다
                    tabIndex={-1}
                    aria-label={action.label}
                    title={action.title ?? action.label}
                    disabled={action.disabled}
                    data-action={action.key}
                    // 누르는 동안 트리의 포커스(선택 색)를 뺏지 않는다
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      // 행 클릭(그룹 접고 펴기)으로 번지지 않게 한다
                      e.stopPropagation();
                      action.onSelect();
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <Icon name={action.icon} />
                  </button>
                ))}
                {node.favoritable ? (
                  <button
                    type="button"
                    className={styles.star}
                    // 행마다 탭 정지를 만들지 않는다. 키보드로는 메뉴와 세로 툴바가 같은 일을 한다
                    tabIndex={-1}
                    aria-label={favorite ? S.branches.removeFavorite : S.branches.addFavorite}
                    aria-pressed={favorite}
                    title={favorite ? S.branches.removeFavorite : S.branches.addFavorite}
                    // 누르는 동안 트리의 포커스(선택 색)를 뺏지 않는다
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(node);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <Icon name={favorite ? 'star' : 'starEmpty'} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </ContextMenuArea>
    </div>
  );
});
