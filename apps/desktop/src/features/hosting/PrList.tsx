import type { PullRequest } from '@mgit/ipc';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { ContextMenuArea } from '../../components/ContextMenu';
import { hasModifier, rovingIndex } from '../../components/roving';
import { isContextMenuKey, openContextMenuAt } from '../../components/tree-keys';
import styles from './PrList.module.css';
import { openPr, type PrDeps, prBadges, prMenu, prNumberLabel } from './pr-tool';

export interface PrListProps {
  /** 보일 PR (번호가 큰 것부터 — 코어가 준 순서 그대로) */
  prs: readonly PullRequest[];
  /** 목록의 접근성 이름 (도구 창 제목: Pull Requests / Merge Requests) */
  label: string;
  /** 메뉴·웹에서 열기의 동작 묶음 */
  deps: PrDeps;
}

/**
 * Pull Requests 도구 창의 목록 (W24): 옛 PR 섹션의 행을 그대로 옮겼다 — 첫 줄 `#번호 제목`(제목은 말줄임, 행 툴팁 =
 * 제목), 둘째 줄 배지(draft·리뷰·검사·충돌, `prBadges`) + 작성자(좁으면 줄바꿈). 더블클릭 = 웹에서 열기, 우클릭 = 메뉴 셋
 * (`prMenu`).
 * - 키보드 (공용 규칙 — Stash 목록과 같다): 목록이 Tab 정지 하나(포커스는 목록이 받고 커서를 `aria-activedescendant` 로
 *   알린다). ↑↓·Home·End·PageUp/Down = 커서(고른 행이 따라간다), Enter = 더블클릭과 같은 웹에서 열기, ⇧F10·메뉴 키 =
 *   커서 행의 메뉴. 수정키 조합은 앱 단축키 몫이다
 * - 클릭은 그 행을 고르기만 한다 (옛 섹션은 한 번 클릭에 동작이 없었다)
 */
export function PrList({ prs, label, deps }: PrListProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // 고른 행(웹 주소로 가리킨다). 고른 행이 목록에서 사라지면 커서는 첫 행으로 돌아간다
  const [picked, setPicked] = useState<string | null>(null);
  const found = picked === null ? -1 : prs.findIndex((p) => p.webUrl === picked);
  const cursorIndex = found >= 0 ? found : prs.length > 0 ? 0 : -1;
  const rowDomId = (index: number) => `${baseId}-pr-${index}`;
  const rowAt = (index: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);

  /** 커서를 그 행으로 옮기고(고른다) 보이게 스크롤한다 */
  const moveCursor = (index: number) => {
    const pr = prs[index];
    if (!pr) {
      return;
    }
    setPicked(pr.webUrl);
    rowAt(index)?.scrollIntoView?.({ block: 'nearest' });
  };

  /** 목록의 키: 이동·웹에서 열기·메뉴 */
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
    const pr = prs[cursorIndex];
    if (e.key === 'Enter' && pr) {
      e.preventDefault();
      openPr(pr, deps);
      return;
    }
    const next = rovingIndex(e.key, cursorIndex, prs.length, 'vertical', false);
    if (next !== null) {
      e.preventDefault();
      moveCursor(next);
    }
  };

  return (
    <ContextMenuArea<PullRequest>
      className={styles.listArea}
      resolveTarget={(e) => {
        const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
        return el ? (prs[Number(el.getAttribute('data-row-index'))] ?? null) : null;
      }}
      items={(pr) => prMenu(pr, deps)}
    >
      <div
        ref={listRef}
        className={styles.list}
        role="listbox"
        aria-label={label}
        aria-activedescendant={cursorIndex >= 0 ? rowDomId(cursorIndex) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {prs.map((pr, index) => (
          // 포커스는 목록이 받으므로 행은 포커스 대상이 아니다 (aria-activedescendant)
          // biome-ignore lint/a11y/useFocusableInteractive: 목록이 포커스를 받고 행은 activedescendant 로 알린다
          // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 목록의 onKeyDown 이 맡는다
          <div
            key={pr.webUrl}
            id={rowDomId(index)}
            className={styles.row}
            role="option"
            aria-selected={pr.webUrl === picked}
            data-row-index={index}
            data-cursor={index === cursorIndex ? 'true' : 'false'}
            title={pr.title}
            onClick={() => setPicked(pr.webUrl)}
            onDoubleClick={() => openPr(pr, deps)}
            onContextMenu={() => setPicked(pr.webUrl)}
          >
            <span className={styles.line}>
              <span className={styles.number}>{prNumberLabel(pr)}</span>
              <span className={styles.title}>{pr.title}</span>
            </span>
            <span className={styles.meta}>
              {prBadges(pr).map((badge) => (
                <span
                  key={badge.kind}
                  className={styles.badge}
                  data-badge={badge.kind}
                  data-tone={badge.tone ?? undefined}
                  title={badge.title}
                >
                  {badge.text}
                </span>
              ))}
              <span className={styles.author}>{pr.author}</span>
            </span>
          </div>
        ))}
      </div>
    </ContextMenuArea>
  );
}
