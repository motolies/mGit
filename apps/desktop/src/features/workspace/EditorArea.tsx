import { formatShortcut, S } from '@mgit/ui';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { registerCommand } from '../../command-registry';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { hasModifier, rovingIndex } from '../../components/roving';
import { captureFocusReturn } from '../../components/use-modal';
import { ToolButton } from '../../layout/ToolButton';
import styles from './EditorArea.module.css';

/** 탭 막대가 문서에 대해 알아야 하는 것 */
export interface EditorTabDoc {
  id: string;
  /** 고정 탭인지. false 면 미리보기 탭 (기울임 글씨) */
  pinned: boolean;
}

export interface EditorAreaProps<D extends EditorTabDoc> {
  /** 열린 문서 (탭 순서) */
  docs: readonly D[];
  activeId: string | null;
  /** 탭 제목 */
  titleOf: (doc: D) => string;
  /** 제목 뒤의 흐린 보조 글자 (같은 이름의 문서를 가른다). 없으면 undefined */
  detailOf?: (doc: D) => string | undefined;
  /** 탭 툴팁. 없으면 제목 (+ 보조 글자) */
  tooltipOf?: (doc: D) => string | undefined;
  /** 문서 종류에 맞는 화면. 종류 → 렌더러 대응은 컨테이너가 정한다 */
  renderDoc: (doc: D) => ReactNode;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 미리보기 탭을 고정 탭으로 (탭 더블클릭) */
  onPin: (id: string) => void;
  /** 문서 종류별 탭 우클릭 메뉴 */
  tabMenu?: (doc: D) => MenuItem[];
  /** 저장하지 않은 변경 여부 */
  dirtyOf?: (doc: D) => boolean;
  /** 탭이 하나도 없을 때 보일 것 */
  empty: ReactNode;
}

/**
 * 에디터 공간 (ED-01·02): 탭 막대 + 활성 문서 하나. 문서가 무엇인지는 모르고(제목과 화면을 받는다)
 * 탭의 활성화·닫기·고정만 알린다. 미리보기 탭은 기울임 글씨로 보인다.
 * 키보드 (W19 ③): 탭 막대 하나가 Tab 정지 하나다 — 활성 탭만 Tab 으로 닿고, ←→·Home·End 로 옆 탭을 연다(끝에서
 * 돈다). Delete·Backspace 는 그 탭을 닫는다(⌘W 와 같다 — 세션 문서의 확인은 `onClose` 의 몫). 탭의 닫기 단추는
 * 마우스 대상이라 Tab 정지가 아니다
 */
export function EditorArea<D extends EditorTabDoc>({
  docs,
  activeId,
  titleOf,
  detailOf,
  tooltipOf,
  renderDoc,
  onActivate,
  onClose,
  onPin,
  tabMenu,
  dirtyOf,
  empty,
}: EditorAreaProps<D>) {
  const baseId = useId();
  const areaRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // 키보드로 탭을 닫았으면 다음에 활성이 되는 탭으로 포커스를 옮긴다 (닫힌 탭과 함께 포커스가 사라지지 않게)
  const refocus = useRef(false);
  const active = docs.find((d) => d.id === activeId) ?? null;
  const activeIndex = active ? docs.indexOf(active) : -1;
  const tabId = (index: number) => `${baseId}-tab-${index}`;
  const panelId = `${baseId}-panel`;
  const origins = useRef(new Map<string, () => void>());
  const previous = useRef<{ ids: Set<string>; active: string | null }>({
    ids: new Set(),
    active: null,
  });

  // 문서를 연 출발 영역을 기억하고 닫힌 뒤 복귀한다. 새 미리보기로 교체한 경우에는 복귀하지 않는다.
  useLayoutEffect(() => {
    const before = previous.current;
    const ids = new Set(docs.map((doc) => doc.id));
    const added = docs.filter((doc) => !before.ids.has(doc.id));
    const focused = document.activeElement;
    if (
      added.length > 0 &&
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !areaRef.current?.contains(focused)
    ) {
      for (const doc of added) origins.current.set(doc.id, captureFocusReturn());
    }
    if (
      before.active &&
      !ids.has(before.active) &&
      added.length === 0 &&
      (focused === document.body || areaRef.current?.contains(focused))
    ) {
      const restore = origins.current.get(before.active);
      if (restore) {
        restore();
        refocus.current = false;
      } else {
        refocus.current = true;
      }
    }
    for (const id of before.ids) if (!ids.has(id)) origins.current.delete(id);
    previous.current = { ids, active: activeId };
  });

  // 미리보기 고정은 탭과 본문에서 동일한 명령으로 실행한다.
  useEffect(() => {
    if (!areaRef.current) return;
    return registerCommand('editor.pin', areaRef.current, {
      enabled: () => active !== null && !active.pinned,
      run: () => {
        if (active) onPin(active.id);
      },
    });
  }, [active, onPin]);

  useLayoutEffect(() => {
    if (!refocus.current) {
      return;
    }
    refocus.current = false;
    const target = tabsRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    (target ?? areaRef.current)?.focus();
  });

  if (docs.length === 0) {
    return (
      <div ref={areaRef} className={styles.area} tabIndex={-1}>
        {empty}
      </div>
    );
  }

  /** 탭 막대의 키: ←→·Home·End 옆 탭 열기, Delete·Backspace 그 탭 닫기 */
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, doc: D, index: number) => {
    if (hasModifier(e)) {
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      refocus.current = true;
      onClose(doc.id);
      return;
    }
    const next = rovingIndex(e.key, index, docs.length, 'horizontal');
    const target = next === null ? undefined : docs[next];
    if (!target || next === null) {
      return;
    }
    e.preventDefault();
    onActivate(target.id);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div ref={areaRef} className={styles.area} tabIndex={-1}>
      <ContextMenuArea<D>
        className={styles.tabsMenu}
        resolveTarget={(event) => {
          const id = (event.target as HTMLElement | null)
            ?.closest('[data-editor-doc]')
            ?.getAttribute('data-editor-doc');
          const doc = docs.find((item) => item.id === id);
          return doc && tabMenu?.(doc).length ? doc : null;
        }}
        items={(doc) => tabMenu?.(doc) ?? []}
      >
        <div
          ref={tabsRef}
          className={styles.tabs}
          role="tablist"
          aria-label={S.workspace.editorTabs}
        >
          {docs.map((doc, index) => {
            const title = titleOf(doc);
            const detail = detailOf?.(doc);
            const tooltip = tooltipOf?.(doc) ?? (detail ? `${title} ${detail}` : title);
            const selected = doc.id === activeId;
            // 활성 탭이 없으면 첫 탭이 Tab 정지다
            const stop = activeIndex >= 0 ? selected : index === 0;
            return (
              <div
                key={doc.id}
                data-editor-doc={doc.id}
                className={styles.tab}
                role="presentation"
                data-active={selected ? 'true' : 'false'}
                data-preview={doc.pinned ? 'false' : 'true'}
              >
                <button
                  type="button"
                  id={tabId(index)}
                  className={styles.tabTitle}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={selected ? panelId : undefined}
                  tabIndex={stop ? 0 : -1}
                  title={doc.pinned ? tooltip : `${tooltip} — ${S.workspace.pinHint}`}
                  onClick={() => onActivate(doc.id)}
                  onDoubleClick={() => onPin(doc.id)}
                  onKeyDown={(e) => onKeyDown(e, doc, index)}
                >
                  {title}
                  {dirtyOf?.(doc) ? ' ●' : ''}
                  {detail ? <span className={styles.tabDetail}>{detail}</span> : null}
                </button>
                <ToolButton
                  icon="close"
                  label={S.workspace.closeTab(title)}
                  tabIndex={-1}
                  onClick={() => {
                    refocus.current = true;
                    onClose(doc.id);
                  }}
                />
              </div>
            );
          })}
        </div>
      </ContextMenuArea>
      {active ? (
        <div
          id={panelId}
          className={styles.doc}
          role="tabpanel"
          aria-labelledby={activeIndex >= 0 ? tabId(activeIndex) : undefined}
        >
          {renderDoc(active)}
        </div>
      ) : null}
    </div>
  );
}

/** 빈 상태에 보일 단축키 한 줄 */
export interface EditorHint {
  label: string;
  /** `mod+shift+p` 꼴. 없으면 그 줄을 그리지 않는다 */
  shortcut: string | undefined;
}

export interface EditorEmptyStateProps {
  hints: readonly EditorHint[];
  /** 안내 아래의 링크 (폴더 워크스페이스의 "개요 열기", 저장소 워크스페이스의 "tag 관리 열기") */
  action?: { label: string; onClick: () => void };
}

/** 열린 문서가 없을 때의 에디터 공간 (ED-07): 단축키 안내 몇 줄과 다시 시작할 링크 */
export function EditorEmptyState({ hints, action }: EditorEmptyStateProps) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{S.workspace.empty.title}</div>
      <dl className={styles.hints}>
        {hints.map((hint) =>
          hint.shortcut === undefined ? null : (
            <div key={hint.label} className={styles.hint}>
              <dt>{hint.label}</dt>
              <dd>{formatShortcut(hint.shortcut)}</dd>
            </div>
          ),
        )}
      </dl>
      {action ? (
        <button type="button" className={styles.link} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
