import type { StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { type MouseEvent, useMemo, useState } from 'react';
import { useRovingToolbar } from '../../components/roving';
import styles from './FileList.module.css';
import { buildPathTree, type PathTreeNode } from './path-tree';

/** 영역 기준의 상태 글자 (M·A·D·R·C·U·?) */
export function statusLetter(e: StatusEntry, staged: boolean): string {
  if (e.conflict) {
    return 'U';
  }
  const state = staged ? e.index : e.worktree;
  switch (state) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typeChanged':
      return 'T';
    case 'untracked':
      return '?';
    case 'unmerged':
      return 'U';
    default:
      return ' ';
  }
}

export interface FileListProps {
  entries: readonly StatusEntry[];
  /** staged 영역이면 index 쪽 상태를 보여 준다 */
  staged: boolean;
  view: 'tree' | 'flat';
  selected: ReadonlySet<string>;
  /** 클릭 선택 (Shift·Cmd 는 이벤트로 판별) */
  onSelect(path: string, e: MouseEvent): void;
  /** 더블클릭·Enter 로 열기 */
  onOpen(path: string): void;
  /** 현재 중앙에 열린 파일 */
  openPath?: string | null;
}

/** 목록 안에서 키보드로 옮겨 다니는 항목: 파일 행과 디렉터리 접기 단추 (W27) */
const FILE_LIST_ITEMS = 'li[data-path], button:not([disabled])';

/**
 * 변경 파일 목록 (CHG-01). 트리·플랫 보기, 다중 선택. 목록 하나가 Tab 정지 하나다 (W27 — 큰 목록의 공용 규칙): 파일 행과
 * 디렉터리 단추 사이를 ↑↓·Home·End·PageUp·PageDown 으로 옮기고(끝에서 멈춘다), 파일 행에서 Enter = 열기, Space = 고르기
 */
export function FileList({
  entries,
  staged,
  view,
  selected,
  onSelect,
  onOpen,
  openPath,
}: FileListProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => (view === 'tree' ? buildPathTree(entries) : []), [entries, view]);
  const roving = useRovingToolbar<HTMLUListElement>('vertical', {
    items: FILE_LIST_ITEMS,
    wrap: false,
  });

  /** 파일 행 */
  const fileRow = (e: StatusEntry, depth: number, label: string) => {
    const isSelected = selected.has(e.path);
    return (
      <li
        key={e.path}
        className={styles.file}
        data-selected={isSelected ? 'true' : 'false'}
        data-path={e.path}
        data-open={openPath === e.path ? 'true' : 'false'}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(ev) => onSelect(e.path, ev)}
        onDoubleClick={() => onOpen(e.path)}
        // 목록이 Tab 정지 하나라 지금 행만 tabIndex 0 이다 (`useRovingToolbar` 가 맞춘다). ↑↓ 는 목록이 받는다
        tabIndex={-1}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            onOpen(e.path);
          } else if (ev.key === ' ') {
            ev.preventDefault();
            onSelect(e.path, ev as unknown as MouseEvent);
          }
        }}
        title={e.origPath ? `${e.path} ${S.changes.renamedFrom(e.origPath)}` : e.path}
      >
        <span className={styles.letter} data-letter={statusLetter(e, staged)}>
          {statusLetter(e, staged)}
        </span>
        <span className={styles.name}>{label}</span>
        {view === 'flat' && e.path.includes('/') ? (
          <span className={styles.dir}>{e.path.slice(0, e.path.lastIndexOf('/'))}</span>
        ) : null}
      </li>
    );
  };

  /** 트리 노드 재귀 렌더 */
  const renderNodes = (nodes: PathTreeNode<StatusEntry>[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      if (n.item) {
        return [fileRow(n.item, depth, n.name)];
      }
      const isCollapsed = collapsed.has(n.path);
      return [
        <li key={`d:${n.path}`} className={styles.dirRow} style={{ paddingLeft: 8 + depth * 14 }}>
          <button
            type="button"
            className={styles.toggle}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(n.path)) {
                  next.delete(n.path);
                } else {
                  next.add(n.path);
                }
                return next;
              })
            }
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? '▸' : '▾'} {n.name}
          </button>
        </li>,
        ...(isCollapsed ? [] : renderNodes(n.children, depth + 1)),
      ];
    });

  if (entries.length === 0) {
    return <div className={styles.empty}>{S.changes.empty}</div>;
  }
  return (
    // 목록 안 항목 사이의 화살표 이동을 목록이 받는다 (W27)
    <ul
      ref={roving.ref}
      className={styles.list}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {view === 'tree'
        ? renderNodes(tree, 0)
        : entries.map((e) => fileRow(e, 0, e.path.slice(e.path.lastIndexOf('/') + 1)))}
    </ul>
  );
}
