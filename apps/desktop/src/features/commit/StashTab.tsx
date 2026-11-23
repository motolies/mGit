import type { StashEntry } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { ContextMenuArea } from '../../components/ContextMenu';
import { hasModifier, rovingIndex } from '../../components/roving';
import { isContextMenuKey, openContextMenuAt } from '../../components/tree-keys';
import { StashDetail } from './StashDetail';
import styles from './StashTab.module.css';
import {
  type StashDeps,
  saveStash,
  stashMenu,
  stashRowTitle,
  stashWriteBlocked,
} from './stash-actions';

export interface StashTabProps {
  /** 보일 스태시 (출처 정보 전에는 refs 의 목록 — `stashEntries`) */
  entries: StashEntry[];
  /** 보고 있는 스태시의 oid (상세가 아래 칸에 보인다). 없으면 null */
  viewing: string | null;
  /** 세션 동작·대화상자·pop 뒤 동작. drop 뒤 동작은 이 탭이 정한다(포커스를 이웃 행으로) */
  deps: Omit<StashDeps, 'onDropped'>;
  /** 목록이 비어 포커스를 둘 행이 없을 때 포커스를 줄 곳 (Stash 탭 단추) */
  focusFallback: () => void;
}

/**
 * Commit 도구 창의 Stash 탭 (WS-22, W23): 위 = 스태시 목록, 아래 = 고른 스태시의 상세(`StashDetail`). 옛 사이드바 스태시
 * 섹션의 행(`stash@{N} 메시지` + branch, 툴팁 = 출처 경로 또는 메시지)·클릭 = 보기·우클릭 메뉴 4개를 그대로 옮겼다.
 * - 키보드: 목록이 Tab 정지 하나(포커스는 목록이 받고 커서를 `aria-activedescendant` 로 알린다). ↑↓·Home·End·PageUp/Down
 *   = 커서, Enter·Space = 보기, ⇧F10·메뉴 키 = 커서 행의 메뉴. 커서를 옮기는 것만으로는 보지 않는다(브랜치 트리와 같다)
 * - 스태시가 없으면 안내와 저장 단추. 아무것도 안 골랐으면 아래 칸에 안내
 * - drop 이 성공하면 Stash 탭에 머물고 커서·포커스를 다음 행(없으면 앞 행)으로 옮긴다 — 지운 행·단추에 포커스가 남지
 *   않게. 남은 행이 없으면 `focusFallback`
 */
export function StashTab({ entries, viewing, deps, focusFallback }: StashTabProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  // 커서: 정한 행이 목록에 있으면 그 행, 아니면 보고 있는 행, 그것도 없으면 첫 행
  const found = cursor === null ? -1 : entries.findIndex((e) => e.info.oid === cursor);
  const viewed = viewing === null ? -1 : entries.findIndex((e) => e.info.oid === viewing);
  const cursorIndex = found >= 0 ? found : viewed >= 0 ? viewed : entries.length > 0 ? 0 : -1;
  const rowDomId = (index: number) => `${baseId}-stash-${index}`;
  const rowAt = (index: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);

  /** drop 뒤: 이웃 행으로 커서와 포커스를 옮긴다. 남은 행이 없으면 대신할 곳으로 */
  const onDropped = (entry: StashEntry) => {
    const at = entries.findIndex((e) => e.info.oid === entry.info.oid);
    const next = entries[at + 1] ?? entries[at - 1] ?? null;
    if (next === null) {
      focusFallback();
      return;
    }
    setCursor(next.info.oid);
    listRef.current?.focus();
  };
  const full: StashDeps = { ...deps, onDropped };

  /** 커서를 그 행으로 옮기고 보이게 스크롤한다 */
  const moveCursor = (index: number) => {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    setCursor(entry.info.oid);
    rowAt(index)?.scrollIntoView?.({ block: 'nearest' });
  };

  /** 목록의 키: 이동·보기·메뉴 (수정키 조합은 앱 단축키 몫) */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isContextMenuKey(e)) {
      if (cursorIndex >= 0) {
        e.preventDefault();
        openContextMenuAt(rowAt(cursorIndex));
      }
      return;
    }
    if (hasModifier(e)) {
      return;
    }
    const entry = entries[cursorIndex];
    if ((e.key === 'Enter' || e.key === ' ') && entry) {
      e.preventDefault();
      void deps.session.selectStash(entry);
      return;
    }
    const next = rovingIndex(e.key, cursorIndex, entries.length, 'vertical', false);
    if (next !== null) {
      e.preventDefault();
      moveCursor(next);
    }
  };

  if (entries.length === 0) {
    return (
      <div className={styles.tab}>
        <div className={styles.empty}>
          <span>{S.stash.empty}</span>
          <Button disabled={stashWriteBlocked(deps.state)} onClick={() => void saveStash(deps)}>
            {S.stash.save}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.tab}>
      <ContextMenuArea<StashEntry>
        className={styles.listArea}
        resolveTarget={(e) => {
          const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
          return el ? (entries[Number(el.getAttribute('data-row-index'))] ?? null) : null;
        }}
        items={(entry) => stashMenu(entry, full)}
      >
        <div
          ref={listRef}
          className={styles.list}
          role="listbox"
          aria-label={S.stash.list}
          aria-activedescendant={cursorIndex >= 0 ? rowDomId(cursorIndex) : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {entries.map((entry, index) => (
            // 포커스는 목록이 받으므로 행은 포커스 대상이 아니다 (aria-activedescendant)
            // biome-ignore lint/a11y/useFocusableInteractive: 목록이 포커스를 받고 행은 activedescendant 로 알린다
            // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 목록의 onKeyDown 이 맡는다
            <div
              key={entry.info.oid}
              id={rowDomId(index)}
              className={styles.row}
              role="option"
              aria-selected={entry.info.oid === viewing}
              data-row-index={index}
              data-cursor={index === cursorIndex ? 'true' : 'false'}
              title={stashRowTitle(entry)}
              onClick={() => {
                setCursor(entry.info.oid);
                void deps.session.selectStash(entry);
              }}
              onContextMenu={() => setCursor(entry.info.oid)}
            >
              <span className={styles.name}>
                {S.stash.name(entry.info.index)} {entry.info.message}
              </span>
              {entry.info.branch ? <span className={styles.track}>{entry.info.branch}</span> : null}
            </div>
          ))}
        </div>
      </ContextMenuArea>
      <div className={styles.detail}>
        {viewed >= 0 ? (
          <StashDetail deps={full} />
        ) : (
          <div className={styles.hint}>{S.stash.pick}</div>
        )}
      </div>
    </div>
  );
}
