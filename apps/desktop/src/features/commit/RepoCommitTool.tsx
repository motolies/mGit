import { S } from '@mgit/ui';
import { type KeyboardEvent, type ReactNode, useMemo } from 'react';
import { hasModifier, rovingIndex } from '../../components/roving';
import { useDialogs } from '../../components/use-dialogs';
import { ToolButton } from '../../layout/ToolButton';
import { ToolWindowFrame } from '../../layout/ToolWindowFrame';
import { useAppStore, useSession } from '../../store';
import { COMMIT_TABS, type CommitTab } from '../../store/app-store';
import styles from './RepoCommitTool.module.css';
import { StashTab } from './StashTab';
import { type StashDeps, saveStash, stashEntries, stashWriteBlocked } from './stash-actions';

/** 탭 단추의 DOM id (탭 패널의 `aria-labelledby`) */
export function commitTabId(tab: CommitTab): string {
  return `commit-tab-${tab}`;
}

/** 탭 패널의 DOM id (고른 탭의 `aria-controls`) */
export const COMMIT_TAB_PANEL_ID = 'commit-tool-panel';

/**
 * 탭 막대 (W19 ③ 의 탭 규칙): `tablist`/`tab`(`aria-controls`)/`tabpanel`, ←→·Home·End 로 옆 탭을 고르고 그 탭에
 * 포커스를 준다. Tab 정지는 고른 탭 하나. Stash 탭은 스태시가 있으면 개수를 붙인다
 */
function CommitTabs({
  active,
  stashCount,
  onSelect,
}: {
  active: CommitTab;
  stashCount: number;
  onSelect: (tab: CommitTab) => void;
}) {
  /** ←→·Home·End: 옆 탭을 고르고 그 탭에 포커스를 준다 */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (hasModifier(e)) {
      return;
    }
    const next = rovingIndex(e.key, COMMIT_TABS.indexOf(active), COMMIT_TABS.length, 'horizontal');
    const tab = next === null ? undefined : COMMIT_TABS[next];
    if (!tab) {
      return;
    }
    e.preventDefault();
    onSelect(tab);
    document.getElementById(commitTabId(tab))?.focus();
  };
  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label={S.commitTool.title}
      onKeyDown={onKeyDown}
    >
      {COMMIT_TABS.map((tab) => (
        <button
          key={tab}
          id={commitTabId(tab)}
          type="button"
          role="tab"
          aria-selected={tab === active}
          aria-controls={tab === active ? COMMIT_TAB_PANEL_ID : undefined}
          tabIndex={tab === active ? 0 : -1}
          className={styles.tab}
          onClick={() => onSelect(tab)}
        >
          {S.commitTool.tabs[tab]}
          {tab === 'stash' && stashCount > 0 ? (
            <span className={styles.count}>{stashCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export interface RepoCommitToolProps {
  /** 변경 탭의 내용: 변경 사항 목록 + 커밋 입력 (`ChangesPanel` 그대로) */
  changes: ReactNode;
}

/**
 * 저장소 탭의 Commit 도구 창 (WS-22, W23): 틀(`ToolWindowFrame`)의 머리에 탭 둘 — 변경(`ChangesPanel`) | Stash(목록·저장·
 * 상세·apply·pop·drop, 옛 사이드바 스태시 섹션과 옛 상세 칸의 `StashDetail` 을 옮김). 보이는 탭은 앱 스토어의
 * `commitTab`(앱 전역 1벌, 저장 안 함)이다. 고른 탭만 그린다(Git 도구 창의 탭과 같다).
 * - Stash 탭일 때 머리 오른쪽에 `+`(stash 저장…, 쓰기를 막는 상태면 꺼짐)
 * - pop 이 성공하면(메뉴·상세 단추 모두) 변경 탭으로 — 되살아난 변경을 본다. 왼쪽 도구 창·로그 선택은 건드리지 않는다
 * - 충돌로 들어오는 길(띠·자동 활성화·WIP 행·상세 칸의 "Commit 도구 창 열기")은 `revealCommitChanges` 로 변경 탭을 고른다
 */
export function RepoCommitTool({ changes }: RepoCommitToolProps) {
  const tab = useAppStore((st) => st.commitTab);
  const setTab = useAppStore((st) => st.setCommitTab);
  const s = useSession((st) => ({
    stashes: st.stashes,
    refStashes: st.refs.stashes,
    viewing: st.stashView?.entry.info.oid ?? null,
    busy: st.busy,
    inOp: st.op !== null,
    selectStash: st.selectStash,
    stashPush: st.stashPush,
    stashApply: st.stashApply,
    stashPop: st.stashPop,
    stashDrop: st.stashDrop,
  }));
  const dialogs = useDialogs();
  const entries = useMemo(() => stashEntries(s.stashes, s.refStashes), [s.stashes, s.refStashes]);
  const deps: Omit<StashDeps, 'onDropped'> = {
    state: { busy: s.busy, inOp: s.inOp },
    session: s,
    dialogs,
    onPopped: () => setTab('changes'),
  };

  return (
    <ToolWindowFrame
      title={S.commitTool.title}
      tabs={<CommitTabs active={tab} stashCount={entries.length} onSelect={setTab} />}
      tools={
        tab === 'stash' ? (
          <ToolButton
            icon="add"
            label={S.stash.save}
            disabled={stashWriteBlocked(deps.state)}
            onClick={() => void saveStash(deps)}
          />
        ) : null
      }
    >
      <div
        className={styles.panel}
        role="tabpanel"
        id={COMMIT_TAB_PANEL_ID}
        aria-labelledby={commitTabId(tab)}
      >
        {tab === 'stash' ? (
          <StashTab
            entries={entries}
            viewing={s.viewing}
            deps={deps}
            focusFallback={() => document.getElementById(commitTabId('stash'))?.focus()}
          />
        ) : (
          changes
        )}
      </div>
      {dialogs.element}
    </ToolWindowFrame>
  );
}
