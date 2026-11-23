import { Icon, type IconName, S } from '@mgit/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { openContextMenuAt, treeKeyCommand } from '../../components/tree-keys';
import { useVirtualTree } from '../../components/use-virtual-tree';
import { ToolButton } from '../../layout/ToolButton';
import styles from './ProjectTree.module.css';
import { fileStamp, type RowDecoration } from './project-rows';
import type { EntryRow, ProjectTreeRow, RootRow } from './project-tree-model';

/** 문서를 여는 방식: 미리보기(단일 클릭·Space) / 고정(더블클릭·Enter) */
export type ProjectOpenMode = 'preview' | 'pinned';

/** 루트 행의 글자 (PT-01): 굵은 이름 + 회색 경로 */
export interface ProjectRoot {
  name: string;
  detail: string;
}

export interface ProjectTreeProps {
  root: ProjectRoot;
  /** 그릴 행. `flattenProjectTree` 가 만든다 */
  rows: readonly ProjectTreeRow[];
  /** 기준 행(마지막으로 고른 행, 키보드 포커스)의 id. 무엇을 고를지는 바깥이 정한다 */
  selected: string | null;
  /** 고른 행들 (다중 선택, PT-07). 주지 않으면 기준 행 하나만 고른 것으로 그린다 */
  selection?: Readonly<Record<string, true>>;
  /** 경로마다의 장식 (저장소 행·파일 상태). 무엇을 붙일지는 컨테이너가 정한다. 없으면 null */
  decorate: (path: string) => RowDecoration | null;
  /**
   * 파일 행의 `날짜, 크기`를 쓸 때의 기준 시각 (PT-10, 24시간 안은 상대 시각). 주지 않으면 쓰지 않는다.
   * 다시 그릴 때마다 바뀌지 않는 값을 준다 (가상 스크롤 행이 시계 때문에 다시 그려지지 않게)
   */
  now?: number;
  /** 트리 위의 안내 한 줄 (폴더에 저장소가 없음 등). 없으면 그리지 않는다 */
  notice?: string | null;
  /**
   * 머리의 도구 단추 뒤(새로고침·다시 스캔·설정 다음)에 붙는 도구. 무엇인지는 컨테이너가 정한다 (저장소 탭의 모듈·서브모듈
   * 메뉴, W25). 없으면 그리지 않는다
   */
  tools?: ReactNode;
  /**
   * 머리와 트리 사이의 띠 (안내 줄 위). 무엇을 싣는지는 컨테이너가 정한다 (저장소 탭의 상위 저장소 링크·모듈 범위, W25).
   * 없으면 그리지 않는다
   */
  banner?: ReactNode;
  /** 그 행 하나만 고른다 (그냥 클릭·화살표·선택 밖 행의 우클릭) */
  onSelect: (id: string) => void;
  /** ⌘/Ctrl 클릭: 그 행을 선택에 더하거나 뺀다. 주지 않으면 그냥 클릭과 같다 */
  onToggleSelect?: (id: string) => void;
  /** ⇧클릭·⇧↑↓: 범위 시작 행부터 그 행까지 고른다 (보이는 행 기준). 주지 않으면 그냥 고르기와 같다 */
  onSelectRange?: (id: string) => void;
  /** 루트·디렉터리를 펼치거나 접는다 */
  onToggle: (path: string) => void;
  /** 파일을 연다 */
  onOpenFile: (path: string, mode: ProjectOpenMode) => void;
  /** 잘린 디렉터리를 더 읽는다 */
  onLoadMore: (dir: string) => void;
  /** 읽지 못한 디렉터리를 다시 읽는다 */
  onRetry: (dir: string) => void;
  /** 루트·항목 행의 우클릭 메뉴. 빈 목록이면 메뉴를 열지 않는다 */
  menu: (row: RootRow | EntryRow) => MenuItem[];
  /** 머리의 새로고침 */
  onRefresh: () => void;
  /** 머리의 다시 스캔. 주지 않으면 버튼이 없다 (저장소 루트 1개 모드) */
  onRescan?: () => void;
  /** 머리의 "열린 파일을 트리에서 찾기". 주지 않으면 버튼이 없다 */
  onLocate?: () => void;
  /** 머리의 설정 (폴더 설정 대화상자). 주지 않으면 버튼이 없다 */
  onSettings?: () => void;
  /** 찾을 파일이 없어 "트리에서 찾기" 를 막는다 */
  locateDisabled?: boolean;
  /** 읽는 중이라 새로고침·다시 스캔을 막는다 */
  busy: boolean;
  /** 처음 그릴 때의 스크롤 위치 (탭을 떠났다 돌아왔을 때) */
  initialScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
  /** 이 값이 바뀌면 고른 행이 보이게 스크롤한다 (트리에서 찾기) */
  revealSeq?: number;
}

/** 항목 종류의 아이콘 */
const KIND_ICON: Record<EntryRow['entryKind'], IconName> = {
  dir: 'folder',
  file: 'file',
  symlink: 'symlink',
  other: 'special',
};

/** 펼치거나 열 수 없는 항목의 사유. 열 수 있으면 null */
function inertReason(row: EntryRow): string | null {
  switch (row.entryKind) {
    case 'dir':
      return null;
    case 'symlink':
      return S.project.symlink;
    case 'other':
      return S.project.special;
    case 'file':
      return row.openable ? null : S.project.unopenable;
  }
}

/** 상태 줄의 문구 */
function statusText(row: Extract<ProjectTreeRow, { kind: 'status' }>): string {
  switch (row.status) {
    case 'loading':
      return S.project.loading;
    case 'empty':
      return S.project.empty;
    case 'missing':
      return S.project.missing;
    case 'denied':
      return S.project.denied;
    case 'error':
      return S.project.failed(row.error ?? '');
  }
}

/** 장식의 뒷부분: 브랜치·ahead·behind·배지·변경 수·요약 실패 (PT-02). 저장소 행이 아니면 빈 칸들이다 */
function DecorationTail({ deco }: { deco: RowDecoration }) {
  const changed = deco.changed ?? 0;
  return (
    <>
      {deco.branch != null ? <span className={styles.branch}>{deco.branch}</span> : null}
      {(deco.sync ?? []).map((text) => (
        <span key={text} className={styles.sync}>
          {text}
        </span>
      ))}
      {(deco.badges ?? []).map((badge) => (
        <span key={badge.text} className={styles.badge} data-tone={badge.tone}>
          {badge.text}
        </span>
      ))}
      {changed > 0 ? <span className={styles.changed}>{S.project.changed(changed)}</span> : null}
      {deco.error != null ? (
        <span
          className={styles.warning}
          role="img"
          aria-label={S.project.summaryFailed(deco.error)}
        >
          <Icon name="warning" />
        </span>
      ) : null}
    </>
  );
}

/** 행 끝의 상태 (PT-06, LF-05): 충돌은 ⚠, 그리고 상태 문자. 툴팁이 뜻을 말한다. 문자가 없으면(디렉터리) 그리지 않는다 */
function StatusTail({ status }: { status: NonNullable<RowDecoration['status']> }) {
  if (status.letter === null) {
    return null;
  }
  return (
    <span className={styles.tail}>
      {status.tone === 'conflict' ? (
        <span className={styles.conflict}>
          <Icon name="warning" />
        </span>
      ) : null}
      <span className={styles.letter} title={status.title}>
        {status.letter}
      </span>
    </span>
  );
}

/**
 * Project 도구 창 (PT-01~05·08·09): 머리(새로고침·다시 스캔·트리에서 찾기)와 폴더 전체의 파일 트리.
 * 행과 동작, 행 장식을 모두 props 로 받는다 — 어느 스토어의 데이터인지, 어느 행이 저장소인지 모른다. 머리 끝의 도구
 * (`tools`)와 머리·트리 사이의 띠(`banner`)도 컨테이너가 채우는 빈자리다 (저장소 탭의 모듈·서브모듈 메뉴·범위 띠, W25).
 * 펼친 트리를 평탄화한 행을 가상 스크롤로 그리므로 화면 밖 행은 DOM 에 없다(단계·형제 수·순번은 ARIA 로 알린다).
 * 포커스는 트리 자체가 받고 기준 행을 `aria-activedescendant` 로 알린다.
 * 클릭: 루트·디렉터리 = 고르기 + 펼침 토글, 파일 = 미리보기, 더블클릭·Enter = 고정, Space = 미리보기.
 * 다중 선택(PT-07): ⌘/Ctrl 클릭 = 하나씩 더하고 빼기, ⇧클릭·⇧↑↓ = 범위 — 이때는 펼치거나 열지 않는다.
 * 우클릭: 고른 행이면 선택을 그대로 두고, 아니면 그 행만 고른다
 */
export function ProjectTree({
  root,
  rows,
  selected,
  selection,
  decorate,
  now,
  notice,
  tools,
  banner,
  onSelect,
  onToggleSelect,
  onSelectRange,
  onToggle,
  onOpenFile,
  onLoadMore,
  onRetry,
  menu,
  onRefresh,
  onRescan,
  onLocate,
  onSettings,
  locateDisabled,
  busy,
  initialScrollTop,
  onScrollTopChange,
  revealSeq,
}: ProjectTreeProps) {
  const baseId = useId();
  const treeRef = useRef<HTMLDivElement>(null);
  const { virtualizer, rowHeight, scrollToRow } = useVirtualTree({
    scrollRef: treeRef,
    count: rows.length,
    keyOf: (index) => rows[index]?.id ?? index,
  });
  const selectedIndex = selected === null ? -1 : rows.findIndex((r) => r.id === selected);
  // 키 규칙이 보는 행 모양 (안내 줄은 펼칠 수 없는 잎이다)
  const keyRows = useMemo(
    () =>
      rows.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        expandable: r.kind === 'root' || (r.kind === 'entry' && r.expandable),
        expanded: r.kind === 'root' || r.kind === 'entry' ? r.expanded : false,
      })),
    [rows],
  );
  const items = virtualizer.getVirtualItems();
  const rowDomId = (index: number) => `${baseId}-row-${index}`;
  const selectedRendered = items.some((item) => item.index === selectedIndex);
  /** 그 행이 고른 행인지 */
  const isSelected = (id: string) => (selection ? selection[id] === true : id === selected);

  // 처음 그릴 때 기억해 둔 스크롤 위치로 돌아간다 (트리 상태는 스토어에 남아 있어 행이 이미 있다)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 마운트 때 한 번만 돌린다
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (el && initialScrollTop) {
      el.scrollTop = initialScrollTop;
    }
  }, []);

  // "트리에서 찾기" 가 고른 행으로 스크롤한다. 마운트 때의 값은 지난 일이라 건너뛴다
  const seenReveal = useRef(revealSeq);
  useEffect(() => {
    if (revealSeq === seenReveal.current) {
      return;
    }
    seenReveal.current = revealSeq;
    if (selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: 'center' });
    }
  }, [revealSeq, selectedIndex, virtualizer]);

  /** 그 행을 고르고 보이게 스크롤한다 (키보드). 범위를 벗어나면 끝 행에서 멈춘다 */
  const moveTo = (index: number) => {
    const at = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[at];
    if (!row) {
      return;
    }
    onSelect(row.id);
    scrollToRow(at);
  };

  /** 범위를 그 행까지 넓히고 보이게 스크롤한다 (⇧↑↓). 범위 선택을 받지 않으면 그냥 옮긴다 */
  const extendTo = (index: number) => {
    const at = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[at];
    if (!row || !onSelectRange || selectedIndex < 0) {
      moveTo(index);
      return;
    }
    onSelectRange(row.id);
    scrollToRow(at);
  };

  /** 행의 "누르기": 파일은 연다, 루트·디렉터리는 펼침을 뒤집는다, 더 보기·오류는 그 동작 */
  const activate = (row: ProjectTreeRow, mode: ProjectOpenMode) => {
    switch (row.kind) {
      case 'root':
        onToggle('');
        break;
      case 'entry':
        if (row.expandable) {
          onToggle(row.path);
        } else if (row.openable) {
          onOpenFile(row.path, mode);
        }
        break;
      case 'more':
        if (row.next > 0 && !row.loading) {
          onLoadMore(row.dir);
        }
        break;
      case 'status':
        if (row.status === 'error') {
          onRetry(row.dir);
        }
        break;
      default:
        break;
    }
  };

  /**
   * 트리의 키보드 조작 (공용 규칙 `treeKeyCommand`): ↑↓·Home·End 이동(⇧↑↓ 는 범위 넓히기), ←→ 접기·펼치기와
   * 부모·자식 이동, Enter 고정으로 열기, Space 미리보기, ⇧F10·메뉴 키 우클릭 메뉴
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[selectedIndex];
    const command = treeKeyCommand(e, keyRows, selectedIndex);
    if (!command) {
      return;
    }
    e.preventDefault();
    switch (command.kind) {
      case 'move':
        if (command.extend) {
          extendTo(command.index);
        } else {
          moveTo(command.index);
        }
        break;
      case 'expand':
      case 'collapse':
        if (row?.kind === 'root' || row?.kind === 'entry') {
          onToggle(row.kind === 'root' ? '' : row.path);
        }
        break;
      case 'enter':
        if (row) {
          activate(row, 'pinned');
        }
        break;
      case 'space':
        if (row) {
          activate(row, 'preview');
        }
        break;
      case 'menu':
        openContextMenuAt(treeRef.current?.querySelector(`[data-row-index="${selectedIndex}"]`));
        break;
    }
  };

  /** ⌘/Ctrl·⇧ 와 함께 누른 클릭인지 (다중 선택 — 펼치거나 열지 않는다) */
  const modified = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey;

  /**
   * 행 클릭: 고르고 누른다. 더블클릭의 두 번째 클릭은 고르기만 한다 (펼침이 두 번 뒤집히지 않게).
   * ⌘/Ctrl 은 선택에 더하고 빼기, ⇧ 는 범위 — 둘 다 고르기만 한다
   */
  const onRowClick = (row: ProjectTreeRow, e: MouseEvent) => {
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      onToggleSelect(row.id);
      return;
    }
    if (e.shiftKey && onSelectRange && selectedIndex >= 0) {
      onSelectRange(row.id);
      return;
    }
    onSelect(row.id);
    if (e.detail <= 1 && !modified(e)) {
      activate(row, 'preview');
    }
  };

  /** 루트·항목 행 하나 */
  const renderNode = (row: RootRow | EntryRow, deco: RowDecoration | null) => {
    const expandable = row.kind === 'root' || row.expandable;
    const inert = row.kind === 'entry' ? inertReason(row) : null;
    const icon: IconName =
      deco?.icon ?? (row.kind === 'root' ? 'rootFolder' : KIND_ICON[row.entryKind]);
    const name = row.kind === 'root' ? root.name : row.name;
    const bold = row.kind === 'root' || deco?.bold === true;
    const status = deco?.status ?? null;
    const base = deco?.title ?? (row.kind === 'root' ? root.detail : (inert ?? row.path));
    const title = status ? `${base}\n${status.title}` : base;
    const stamp =
      now !== undefined && row.kind === 'entry' && row.entryKind === 'file'
        ? fileStamp(row.size, row.mtimeMs, now)
        : null;
    return (
      <>
        <span className={styles.twisty}>
          {expandable ? <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} /> : null}
        </span>
        {deco?.iconLabel ? (
          <span className={styles.icon} data-icon={icon} role="img" aria-label={deco.iconLabel}>
            <Icon name={icon} />
          </span>
        ) : (
          <span className={styles.icon} data-icon={icon}>
            <Icon name={icon} />
          </span>
        )}
        <span className={bold ? styles.nameBold : styles.name} title={title}>
          {name}
        </span>
        {row.kind === 'root' ? <span className={styles.detail}>{root.detail}</span> : null}
        {row.kind === 'entry' && deco?.detail ? (
          <span className={styles.detail}>{deco.detail}</span>
        ) : null}
        {stamp !== null ? <span className={styles.stamp}>{stamp}</span> : null}
        {deco ? <DecorationTail deco={deco} /> : null}
        {status ? <StatusTail status={status} /> : null}
      </>
    );
  };

  /** 안내 줄 하나 (상태·더 보기·이름을 읽을 수 없는 항목) */
  const renderNote = (row: Exclude<ProjectTreeRow, RootRow | EntryRow>) => {
    switch (row.kind) {
      case 'status':
        return (
          <>
            <span className={styles.twisty} />
            <span className={styles.note} data-status={row.status}>
              {row.status === 'denied' ? <Icon name="lock" /> : null}
              {row.status === 'error' ? <Icon name="error" /> : null}
              {statusText(row)}
            </span>
            {row.status === 'error' ? (
              <button
                type="button"
                className={styles.link}
                // 행마다 탭 정지를 만들지 않는다. 키보드로는 이 줄에서 Enter 가 같은 일을 한다
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(row.id);
                  onRetry(row.dir);
                }}
              >
                {S.project.retry}
              </button>
            ) : null}
          </>
        );
      case 'more':
        return (
          <>
            <span className={styles.twisty} />
            {row.loading ? (
              <span className={styles.note}>{S.project.moreLoading}</span>
            ) : row.next > 0 ? (
              <span className={styles.more}>{S.project.more(row.next)}</span>
            ) : (
              <span className={styles.note}>{S.project.moreCapped(row.shown, row.total)}</span>
            )}
          </>
        );
      case 'nonUtf8':
        return (
          <>
            <span className={styles.twisty} />
            <span className={styles.note}>
              <Icon name="warning" />
              {S.project.nonUtf8Names(row.count)}
            </span>
          </>
        );
    }
  };

  return (
    <div className={styles.window}>
      <header className={styles.header}>
        <span className={styles.title}>{S.project.title}</span>
        <span className={styles.spacer} />
        {onLocate ? (
          <ToolButton
            icon="locate"
            label={S.project.locate}
            disabled={locateDisabled}
            onClick={onLocate}
          />
        ) : null}
        <ToolButton icon="refresh" label={S.folder.refresh} disabled={busy} onClick={onRefresh} />
        {onRescan ? (
          <ToolButton icon="rescan" label={S.folder.rescan} disabled={busy} onClick={onRescan} />
        ) : null}
        {onSettings ? (
          <ToolButton icon="settings" label={S.project.settings} onClick={onSettings} />
        ) : null}
        {tools}
      </header>
      {banner}
      {notice ? <div className={styles.notice}>{notice}</div> : null}
      <ContextMenuArea<RootRow | EntryRow>
        className={styles.menuArea}
        resolveTarget={(e) => {
          const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
          const row = el ? rows[Number(el.getAttribute('data-row-index'))] : undefined;
          return row && (row.kind === 'root' || row.kind === 'entry') && menu(row).length > 0
            ? row
            : null;
        }}
        items={menu}
      >
        <div
          ref={treeRef}
          className={styles.tree}
          role="tree"
          aria-label={S.project.tree}
          aria-multiselectable={onToggleSelect || onSelectRange ? true : undefined}
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
              const node = row.kind === 'root' || row.kind === 'entry';
              const expandable = row.kind === 'root' || (row.kind === 'entry' && row.expandable);
              const inert = row.kind === 'entry' && inertReason(row) !== null;
              const deco = node ? decorate(row.path) : null;
              return (
                // 포커스는 트리가 받으므로 행은 포커스 대상이 아니다 (aria-activedescendant)
                // biome-ignore lint/a11y/useFocusableInteractive: 트리가 포커스를 받고 행은 activedescendant 로 알린다
                // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 트리의 onKeyDown 이 맡는다
                <div
                  key={item.key}
                  id={rowDomId(item.index)}
                  className={styles.row}
                  role="treeitem"
                  aria-selected={isSelected(row.id)}
                  aria-level={row.depth + 1}
                  aria-setsize={row.setSize}
                  aria-posinset={row.posInSet}
                  aria-expanded={node && expandable ? row.expanded : undefined}
                  aria-disabled={inert ? true : undefined}
                  data-row-index={item.index}
                  data-kind={row.kind === 'entry' ? row.entryKind : row.kind}
                  data-inert={inert ? 'true' : undefined}
                  data-status={deco?.status?.tone}
                  style={
                    {
                      '--depth': row.depth,
                      height: rowHeight,
                      transform: `translateY(${item.start}px)`,
                    } as CSSProperties
                  }
                  title={row.kind === 'entry' ? (inertReason(row) ?? undefined) : undefined}
                  onClick={(e) => onRowClick(row, e)}
                  onDoubleClick={(e) => {
                    if (row.kind === 'entry' && row.openable && !modified(e)) {
                      onOpenFile(row.path, 'pinned');
                    }
                  }}
                  onContextMenu={() => {
                    // 고른 행 위의 우클릭은 선택 전체가 대상이다 (선택을 그대로 둔다)
                    if (!isSelected(row.id)) {
                      onSelect(row.id);
                    }
                  }}
                >
                  {node ? renderNode(row, deco) : renderNote(row)}
                </div>
              );
            })}
          </div>
        </div>
      </ContextMenuArea>
    </div>
  );
}
