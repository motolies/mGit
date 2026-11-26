import { Button, formatNumber, formatTime, S } from '@mgit/ui';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { hasModifier, rovingIndex } from '../../components/roving';
import { type FolderFilter, useAppStore, useFolder, visibleSummaries } from '../../store';
import type { FolderSort } from '../../store/folder-store';
import { GroupMissingMembers } from '../group/GroupMissingMembers';
import { opBadgeText } from '../project/project-rows';
import styles from './Dashboard.module.css';
import { FolderBatchBar } from './FolderBatchBar';
import { useSelectedRepos } from './use-selected-repos';

/** 대시보드 필터 단추의 순서 (하나만 고른다) */
const FILTERS: FolderFilter[] = [
  'all',
  'changed',
  'behind',
  'ahead',
  'noUpstream',
  'stashed',
  'inProgress',
];

/**
 * 폴더 워크스페이스의 개요 문서 (ED-07): 하위 저장소 상태 표(MR-02)와 일괄 작업.
 * 통합 타임라인은 Git 도구 창의 로그 탭에, 통합 변경·일괄 커밋은 Commit 도구 창에(W14 — 머리의 버튼이 연다),
 * 새로고침·다시 스캔은 Project 도구 창 머리에 있고, 창 포커스·주기 재조회는 폴더 스토어(`startAutoRefresh`)가
 * 맡는다. 설정은 "폴더 설정" 대화상자로 연다 (W12). 커밋 검색은 로그의 필터 바가, 브랜치 검색은 브랜치 트리의
 * 검색이 맡는다 (W17 에서 "검색" 보기를 걷어냈다). 표의 체크박스는 프로젝트 트리의 선택과 한 상태다 (PT-07):
 * 체크하면 트리에서 그 저장소 행이 선택에 들어가고, 트리에서 저장소 행을 고르면 여기 체크된다
 */
export function Dashboard() {
  const f = useFolder((st) => ({
    id: st.id,
    name: st.name,
    summaries: st.summaries,
    error: st.error,
    filter: st.filter,
    sort: st.sort,
    refreshedAt: st.refreshedAt,
    setFilter: st.setFilter,
    setSort: st.setSort,
    toggleSelect: st.toggleSelect,
    setSelected: st.setSelected,
    setSettingsOpen: st.setSettingsOpen,
    group: st.group,
  }));
  const selected = useSelectedRepos();
  const openRepositoryAt = useAppStore((s) => s.openRepositoryAt);
  const setLeftTool = useAppStore((s) => s.setLeftTool);
  // 표 본문의 Tab 정지인 줄 (W19 ③): 마지막으로 포커스를 받은 줄
  const [focusRow, setFocusRow] = useState(0);

  const rows = useMemo(() => (f ? visibleSummaries([...f.summaries], f.filter, f.sort) : []), [f]);
  if (!f) {
    return null;
  }
  const visible = rows.map((r) => r.path);
  const allChecked = visible.length > 0 && visible.every((p) => selected.includes(p));
  const stop = Math.min(focusRow, Math.max(0, rows.length - 1));
  /** 정렬 머리의 상태 (보조 기술): 지금 정렬 기준인 열만 내림·오름을 알린다 */
  const sortOf = (key: FolderSort) =>
    f.sort === key ? (key === 'name' ? 'ascending' : 'descending') : undefined;

  /**
   * 표 본문의 키 (W19 ③ — 줄 목록 하나가 Tab 정지 하나): ↑↓·PageUp·PageDown·Home·End 줄 이동, Space 그 줄 체크,
   * Enter 그 저장소를 탭으로 열기(더블클릭과 같다)
   */
  const onBodyKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (hasModifier(e)) {
      return;
    }
    const tr = (e.target as HTMLElement).closest<HTMLElement>('[data-repo-index]');
    const at = Number(tr?.getAttribute('data-repo-index') ?? stop);
    const row = rows[at];
    if (e.target === tr && row && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      if (e.key === ' ') {
        f.toggleSelect(row.path);
      } else {
        void openRepositoryAt(row.path, f.id);
      }
      return;
    }
    const next = rovingIndex(e.key, at, rows.length, 'vertical', false);
    if (next === null) {
      return;
    }
    e.preventDefault();
    setFocusRow(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-repo-index="${next}"]`)?.focus();
  };
  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <span className={styles.title}>{S.folder.title(f.name)}</span>
        <span className={styles.count}>{S.folder.repos(f.summaries.length)}</span>
        <span className={styles.filters}>
          {FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              className={styles.filter}
              data-active={f.filter === k ? 'true' : 'false'}
              aria-pressed={f.filter === k}
              onClick={() => f.setFilter(k)}
            >
              {S.folder.filter[k]}
            </button>
          ))}
        </span>
        <span className={styles.spacer} />
        {f.refreshedAt ? (
          <span className={styles.count}>{S.folder.refreshedAt(formatTime(f.refreshedAt))}</span>
        ) : null}
        <Button onClick={() => setLeftTool('commit')}>{S.folder.openCommitTool}</Button>
        <Button onClick={() => f.setSettingsOpen(true)}>{S.folder.settings.open}</Button>
      </div>
      {f.error ? <div className={styles.error}>{f.error}</div> : null}
      {f.group ? <GroupMissingMembers group={f.group} /> : null}
      <FolderBatchBar />
      {rows.length === 0 ? (
        <div className={styles.empty}>{S.folder.empty}</div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label={S.folder.selectAll}
                    checked={allChecked}
                    // 보이는 줄(필터 적용)만 넣고 뺀다. 숨은 줄의 체크와 트리의 다른 선택은 그대로다
                    onChange={(e) =>
                      f.setSelected(
                        e.target.checked
                          ? [...new Set([...selected, ...visible])]
                          : selected.filter((p) => !visible.includes(p)),
                      )
                    }
                  />
                </th>
                <th aria-sort={sortOf('name')}>
                  <button type="button" className={styles.th} onClick={() => f.setSort('name')}>
                    {S.folder.columns.name}
                  </button>
                </th>
                <th>{S.folder.columns.branch}</th>
                <th aria-sort={sortOf('changed')}>
                  <button type="button" className={styles.th} onClick={() => f.setSort('changed')}>
                    {S.folder.columns.changed}
                  </button>
                </th>
                <th aria-sort={sortOf('behind')}>
                  <button type="button" className={styles.th} onClick={() => f.setSort('behind')}>
                    {S.folder.columns.sync}
                  </button>
                </th>
                <th aria-sort={sortOf('stash')}>
                  <button
                    type="button"
                    className={styles.th}
                    title={S.folder.columns.stashTip}
                    onClick={() => f.setSort('stash')}
                  >
                    {S.folder.columns.stash}
                  </button>
                </th>
                <th>{S.folder.columns.op}</th>
                <th>{S.folder.columns.lastFetch}</th>
              </tr>
            </thead>
            {/* 줄 사이를 옮기는 화살표와 줄의 Space·Enter 는 표 본문이 받는다 (줄은 움직이는 tabindex) */}
            <tbody onKeyDown={onBodyKeyDown}>
              {rows.map((r, i) => (
                <tr
                  key={r.path}
                  className={styles.row}
                  data-error={r.error ? 'true' : 'false'}
                  data-repo-index={i}
                  tabIndex={i === stop ? 0 : -1}
                  onFocus={() => setFocusRow(i)}
                  title={r.error ?? `${r.path} — ${S.folder.openHint}`}
                  onDoubleClick={() => void openRepositoryAt(r.path, f.id)}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={S.folder.selectRepo(r.name)}
                      // 키보드로는 줄의 Space 가 같은 일을 한다 (줄마다 Tab 정지를 만들지 않는다)
                      tabIndex={-1}
                      checked={selected.includes(r.path)}
                      onChange={() => f.toggleSelect(r.path)}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className={styles.name}>
                    {r.name}
                    {r.kind !== 'standalone' ? (
                      <span className={styles.kind}>{S.folder.kind[r.kind]}</span>
                    ) : null}
                  </td>
                  <td>{r.detached ? S.status.detached : (r.branch ?? '')}</td>
                  <td className={styles.num} data-hot={r.changed > 0 ? 'true' : 'false'}>
                    {r.changed > 0 ? r.changed : ''}
                    {r.conflicted > 0 ? ` (${S.status.conflicted(r.conflicted)})` : ''}
                  </td>
                  <td className={styles.num}>
                    {r.ahead === null || r.ahead === undefined
                      ? ''
                      : `${S.status.ahead(r.ahead)} ${S.status.behind(r.behind ?? 0)}`}
                  </td>
                  <td className={styles.num}>
                    {(r.stashCount ?? 0) > 0 ? formatNumber(r.stashCount ?? 0) : ''}
                  </td>
                  <td className={styles.op}>{opBadgeText(r.op)}</td>
                  <td className={styles.muted}>
                    {r.lastFetch ? formatTime(r.lastFetch) : S.folder.never}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
