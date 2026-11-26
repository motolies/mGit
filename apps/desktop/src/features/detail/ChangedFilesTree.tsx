import type { ChangedFile } from '@mgit/ipc';
import { Button, Icon, S } from '@mgit/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { registerCommand } from '../../command-registry';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { useRovingToolbar } from '../../components/roving';
import { openContextMenuAt, treeKeyCommand } from '../../components/tree-keys';
import { useTreeContentWidth } from '../../components/tree-width';
import { useVirtualTree } from '../../components/use-virtual-tree';
import styles from './ChangedFilesTree.module.css';
import { changeLetter } from './change-letter';
import {
  buildChangedFilesTree,
  type ChangedTreeRow,
  changedFileTone,
  changedTreeRows,
} from './changed-files-tree';

/** 트리 맨 위 저장소 행의 표시 */
export interface ChangedFilesRoot {
  /** 저장소 이름 */
  name: string;
  /** 저장소 색 번호 (`--graph-lane-N`, 로그의 띠·레인과 같은 값). 모르면 색 사각형을 그리지 않는다 */
  color?: number | null;
}

export interface ChangedFilesTreeProps {
  files: readonly ChangedFile[];
  selectedPath?: string | null;
  collapsedIds?: ReadonlySet<string>;
  onCollapsedChange?: (ids: ReadonlySet<string>) => void;
  previewOnSelection?: boolean;
  toolbar?: boolean;
  root: ChangedFilesRoot;
  /** 파일을 눌렀을 때 (클릭, Space): 미리보기로 연다 */
  onPreview: (file: ChangedFile) => void;
  /** 파일을 열 때 (더블클릭, Enter): 고정으로 연다 */
  onOpen: (file: ChangedFile) => void;
  /** 파일 행의 우클릭 메뉴. 빈 목록이면 메뉴를 열지 않는다 */
  menu: (file: ChangedFile) => MenuItem[];
}

/** 파일 행의 툴팁: 경로, 이름이 바뀌었으면 `옛 경로 → 새 경로` */
function fileTitle(file: ChangedFile): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

/**
 * 커밋의 변경 파일 트리 (CD-01): 저장소 루트(색 사각형, 파일 수) > 디렉터리(파일 수, 단일 자식 사슬 압축) >
 * 파일(상태 문자 + 상태 색 이름). 스토어를 모르고 받은 파일과 동작만 쓴다 — 무엇을 여는지는 컨테이너가 정한다.
 * 포커스는 트리가 받고 선택한 행을 `aria-activedescendant` 로 알린다. ↑↓ 는 선택만 옮기고 파일을 열지 않는다
 * (Space = 미리보기, Enter = 고정). 펼침과 선택은 이 화면의 상태라 커밋이 바뀌면(컨테이너가 key 로) 새로 시작한다.
 * 파일이 수천 개인 커밋이 있으므로 가상 스크롤로 그린다 — 화면 밖 행은 DOM 에 없고 단계·형제 수·순번은 ARIA 로 알린다 (W18)
 */
export function ChangedFilesTree({
  files,
  root,
  onPreview,
  onOpen,
  menu,
  selectedPath,
  collapsedIds,
  onCollapsedChange,
  previewOnSelection = true,
  toolbar = true,
}: ChangedFilesTreeProps) {
  const tools = useRovingToolbar<HTMLDivElement>('horizontal');
  const baseId = useId();
  const treeRef = useRef<HTMLDivElement>(null);
  const [localCollapsed, setLocalCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const collapsed = collapsedIds ?? localCollapsed;
  const setCollapsed = (update: (previous: ReadonlySet<string>) => ReadonlySet<string>) => {
    const next = update(collapsed);
    if (onCollapsedChange) onCollapsedChange(next);
    else setLocalCollapsed(next);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = useMemo(() => buildChangedFilesTree(files), [files]);
  const rows = useMemo(
    () => changedTreeRows(root.name, nodes, collapsed),
    [root.name, nodes, collapsed],
  );
  const { virtualizer, rowHeight, scrollToRow } = useVirtualTree({
    scrollRef: treeRef,
    count: rows.length,
    keyOf: (index) => rows[index]?.id ?? index,
  });
  const widthRows = useMemo(
    () =>
      rows.map((row) => ({
        depth: row.depth,
        icons: 2,
        texts: [
          { text: row.name, bold: row.kind === 'root' },
          {
            text: row.file?.oldPath
              ? S.changes.renamedFrom(row.file.oldPath)
              : row.kind === 'file'
                ? ''
                : S.detail.fileCount(row.files),
          },
        ],
      })),
    [rows],
  );
  const contentWidth = useTreeContentWidth(treeRef, widthRows);
  const selectedIndex = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
  const items = virtualizer.getVirtualItems();
  const selectedRendered = items.some((item) => item.index === selectedIndex);
  const rowDomId = (index: number) => `${baseId}-row-${index}`;
  // 외부 탐색이 고른 파일은 접힌 부모를 열고 화면 안으로 드러낸다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 사용자의 접힘 변경은 선택 경로를 다시 펼치지 않는다.
  useEffect(() => {
    if (!selectedPath) return;
    const all = changedTreeRows(root.name, nodes, new Set());
    const row = all.find((row) => row.file?.path === selectedPath);
    if (!row) return;
    setSelectedId(row.id);
    setCollapsed((previous) => {
      const next = new Set(previous);
      let parent = row.parentId;
      while (parent !== null) {
        next.delete(parent);
        parent = all.find((item) => item.id === parent)?.parentId ?? null;
      }
      return next;
    });
  }, [selectedPath]);
  // 선택한 행이 가상 뷰포트 밖에 있어도 스크롤한 뒤 접근성 대상이 연결된다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 목록의 순번이 바뀔 때만 위치를 맞춘다.
  useEffect(() => {
    if (selectedIndex >= 0) scrollToRow(selectedIndex);
  }, [selectedIndex, rows.length]);

  // 선택 파일의 Diff 열기는 Enter 와 같은 고정 문서 경로를 쓴다.
  useEffect(() => {
    if (!treeRef.current) return;
    const file = rows[selectedIndex]?.file;
    return registerCommand('file.showDiff', treeRef.current, {
      enabled: () => file !== undefined,
      run: () => {
        if (file) onOpen(file);
      },
    });
  }, [rows, selectedIndex, onOpen]);

  /** 그 행을 고르고 보이게 스크롤한다. 범위를 벗어나면 끝 행에서 멈춘다 */
  const select = (index: number) => {
    const at = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[at];
    if (!row) {
      return;
    }
    setSelectedId(row.id);
    scrollToRow(at);
    if (previewOnSelection && row.file) onPreview(row.file);
  };

  /** 디렉터리·루트를 펼치거나 접는다 */
  const setExpanded = (row: ChangedTreeRow, expanded: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (expanded) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
  };

  /**
   * 트리의 키보드 조작 (공용 규칙 `treeKeyCommand`): ↑↓·Home·End 이동, ←→ 접기·펼치기와 부모·자식 이동, Enter 고정으로
   * 열기, Space 미리보기(저장소·디렉터리 행은 둘 다 펼침 뒤집기), ⇧F10·메뉴 키 우클릭 메뉴
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
        select(command.index);
        break;
      case 'expand':
      case 'collapse':
        if (row) {
          setExpanded(row, command.kind === 'expand');
        }
        break;
      case 'enter':
      case 'space':
        if (row?.file) {
          (command.kind === 'enter' ? onOpen : onPreview)(row.file);
        } else if (row?.expandable) {
          setExpanded(row, !row.expanded);
        }
        break;
      case 'menu':
        openContextMenuAt(treeRef.current?.querySelector(`[data-row-index="${selectedIndex}"]`));
        break;
    }
  };

  return (
    <div className={styles.menuArea}>
      {toolbar && (
        <div
          {...tools}
          className={styles.toolbar}
          role="toolbar"
          aria-label={S.detail.changedFiles}
        >
          <span>{S.detail.fileCount(files.length)}</span>
          <Button size="compact" onClick={() => setCollapsed(() => new Set())}>
            {S.commitTool.expandAll}
          </Button>
          <Button
            size="compact"
            onClick={() => {
              setSelectedId('root');
              setCollapsed(
                () =>
                  new Set(
                    changedTreeRows(root.name, nodes, new Set())
                      .filter((row) => row.expandable)
                      .map((row) => row.id),
                  ),
              );
            }}
          >
            {S.commitTool.collapseAll}
          </Button>
        </div>
      )}
      <ContextMenuArea<ChangedFile>
        className={styles.menuArea}
        resolveTarget={(e) => {
          const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
          const row = el ? rows[Number(el.getAttribute('data-row-index'))] : undefined;
          return row?.file && menu(row.file).length > 0 ? row.file : null;
        }}
        items={menu}
      >
        <div
          ref={treeRef}
          className={styles.tree}
          data-command-scope="files"
          role="tree"
          data-primary-focus="list"
          aria-label={S.detail.changedFiles}
          aria-activedescendant={selectedRendered ? rowDomId(selectedIndex) : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <div
            className={styles.inner}
            role="presentation"
            style={{ height: virtualizer.getTotalSize(), minWidth: contentWidth }}
          >
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) {
                return null;
              }
              const index = item.index;
              const file = row.file;
              const letter = file ? changeLetter(file.change.kind) : null;
              return (
                // 포커스는 트리가 받으므로 행은 포커스 대상이 아니다 (aria-activedescendant)
                // biome-ignore lint/a11y/useFocusableInteractive: 트리가 포커스를 받고 행은 activedescendant 로 알린다
                // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 트리의 onKeyDown 이 맡는다
                <div
                  key={item.key}
                  id={rowDomId(index)}
                  className={styles.row}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-setsize={row.setSize}
                  aria-posinset={row.posInSet}
                  aria-selected={index === selectedIndex}
                  aria-expanded={row.expandable ? row.expanded : undefined}
                  data-row-index={index}
                  data-kind={row.kind}
                  data-tone={file ? changedFileTone(file) : undefined}
                  style={
                    {
                      '--depth': row.depth,
                      height: rowHeight,
                      transform: `translateY(${item.start}px)`,
                    } as CSSProperties
                  }
                  title={file ? fileTitle(file) : undefined}
                  onClick={() => {
                    treeRef.current?.focus();
                    setSelectedId(row.id);
                    if (file) {
                      onPreview(file);
                    } else if (row.expandable) {
                      setExpanded(row, !row.expanded);
                    }
                  }}
                  onDoubleClick={() => {
                    if (file) {
                      onOpen(file);
                    }
                  }}
                  onContextMenu={() => setSelectedId(row.id)}
                >
                  <span className={styles.twisty}>
                    {row.expandable ? (
                      <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} />
                    ) : null}
                  </span>
                  {row.kind === 'root' ? (
                    root.color === undefined || root.color === null ? null : (
                      <span
                        className={styles.swatch}
                        data-testid="repo-swatch"
                        style={
                          { '--repo-color': `var(--graph-lane-${root.color})` } as CSSProperties
                        }
                      />
                    )
                  ) : row.kind === 'dir' ? (
                    <span className={styles.icon}>
                      <Icon name="folder" />
                    </span>
                  ) : (
                    <span className={styles.letter} data-letter={letter}>
                      {letter}
                    </span>
                  )}
                  <span className={row.kind === 'root' ? styles.rootName : styles.name}>
                    {row.name}
                  </span>
                  {row.kind === 'file' ? (
                    file?.oldPath ? (
                      <span className={styles.muted}>{S.changes.renamedFrom(file.oldPath)}</span>
                    ) : null
                  ) : (
                    <span className={styles.muted}>{S.detail.fileCount(row.files)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ContextMenuArea>
    </div>
  );
}
