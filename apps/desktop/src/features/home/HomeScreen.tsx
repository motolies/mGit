import type { GroupListItem, RecentEntry } from '@mgit/ipc';
import { Button, formatDateTime, Icon, S } from '@mgit/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { useAppStore } from '../../store';
import { GROUP_GLYPH, groupKey } from '../../store/root-space';
import { batchCloneFlow } from './batch-clone';
import styles from './HomeScreen.module.css';
import { cloneFlow, initFlow } from './repo-flows';

/** 탭이 없을 때 중앙에 보이는 시작 화면 (REPO-05): 최근 목록 + 열기·clone·init·스캔 */
export function HomeScreen() {
  const recent = useAppStore((s) => s.recent);
  const templates = useAppStore((s) => s.templates);
  const pickDirectory = useAppStore((s) => s.pickDirectory);
  const isOpening = useAppStore((s) => s.isOpening);
  const cloneOp = useAppStore((s) => s.cloneOp);
  const openRepository = useAppStore((s) => s.openRepository);
  const openRepositoryAt = useAppStore((s) => s.openRepositoryAt);
  const setAppDialog = useAppStore((s) => s.setAppDialog);
  const openFolderAt = useAppStore((s) => s.openFolderAt);
  const pinRecent = useAppStore((s) => s.pinRecent);
  const removeRecent = useAppStore((s) => s.removeRecent);
  const scanFolder = useAppStore((s) => s.scanFolder);
  const cloneRepository = useAppStore((s) => s.cloneRepository);
  const cloneRepositories = useAppStore((s) => s.cloneRepositories);
  const notice = useAppStore((s) => s.notice);
  const cancelClone = useAppStore((s) => s.cancelClone);
  const initRepository = useAppStore((s) => s.initRepository);
  const loadRecent = useAppStore((s) => s.loadRecent);
  const groups = useAppStore((s) => s.groups);
  const loadGroups = useAppStore((s) => s.loadGroups);
  const openGroupAt = useAppStore((s) => s.openGroupAt);
  const updateGroup = useAppStore((s) => s.updateGroup);
  const setGroupDialog = useAppStore((s) => s.setGroupDialog);
  const dialogs = useDialogs();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'folder' | 'repo' | 'group'>('all');
  const sessions = useAppStore((s) => s.sessions);
  const returnToWorkspace = useAppStore((s) => s.returnToWorkspace);
  const canReturn = useAppStore((s) => s.sessionOrder.length > 0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    void loadRecent();
    void loadGroups();
  }, [loadRecent, loadGroups]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recent.filter(
      (r) =>
        (kind === 'all' || r.kind === kind) &&
        (q === '' || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)),
    );
  }, [recent, query, kind]);
  // 그룹 묶음 (MR-13): 코어가 고정 먼저, 그다음 최근에 연 순으로 준다. 이름·멤버 경로로 찾는다
  const shownGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter(
      (g) =>
        q === '' ||
        g.name.toLowerCase().includes(q) ||
        g.members.some((m) => m.path.toLowerCase().includes(q)),
    );
  }, [groups, query]);
  const sections =
    kind === 'group'
      ? []
      : [
          {
            title: S.home.favorites,
            entries: filtered.filter((r) => r.pinned),
            empty: S.home.noFavorites,
          },
          { title: S.home.recent, entries: filtered.filter((r) => !r.pinned), empty: S.home.empty },
        ];
  const showGroups = kind === 'all' || kind === 'group';

  /** clone 흐름 (공용 흐름 함수) */
  const clone = () => cloneFlow(dialogs, { pickDirectory, cloneRepository });

  /** 여러 저장소 clone 흐름 (공용 흐름 함수): 끝나면 상위 폴더가 폴더 탭으로 열린다 */
  const cloneMany = () => batchCloneFlow(dialogs, { pickDirectory, cloneRepositories, notice });

  /** init 흐름 (공용 흐름 함수) */
  const init = () => initFlow(dialogs, { pickDirectory, templates, initRepository });

  /** 그룹 열기 (이미 열려 있으면 그 탭으로 간다) */
  const openGroup = (g: GroupListItem) => {
    if (useAppStore.getState().isOpening) return;
    void openGroupAt(g.id);
  };

  /** 최근 항목 열기 (폴더면 폴더 탭) */
  const open = (r: RecentEntry) => {
    if (useAppStore.getState().isOpening) return;
    const existing = Object.values(sessions).find((session) => session.path === r.path);
    if (existing) {
      useAppStore.getState().setActiveSession(existing.id);
      return;
    }
    if (r.kind === 'folder') {
      void openFolderAt(r.path);
    } else {
      void openRepositoryAt(r.path);
    }
  };

  return (
    <div className={styles.home}>
      <div className={styles.recentHeader}>
        <h1 className={styles.recentTitle}>{S.home.title}</h1>
        {canReturn ? <Button onClick={returnToWorkspace}>{S.home.back}</Button> : null}
      </div>
      <div className={styles.actions}>
        <Button variant="primary" disabled={isOpening} onClick={() => void openRepository()}>
          {S.home.chooseDirectory}
        </Button>
        <Button
          disabled={isOpening || (cloneOp !== null && !cloneOp.done)}
          onClick={() => void clone()}
        >
          {S.home.clone}
        </Button>
        <Button
          disabled={isOpening || (cloneOp !== null && !cloneOp.done)}
          onClick={() => void cloneMany()}
        >
          {S.home.cloneMany}
        </Button>
        <Button disabled={isOpening} onClick={() => void init()}>
          {S.home.init}
        </Button>
        <Button disabled={isOpening} onClick={() => void scanFolder()}>
          {S.home.scan}
        </Button>
        <Button disabled={isOpening} onClick={() => setAppDialog('remoteRepos')}>
          {S.home.browseRemote}
        </Button>
        <Button disabled={isOpening} onClick={() => setGroupDialog({ mode: 'create' })}>
          {S.group.create}
        </Button>
      </div>
      {cloneOp && !cloneOp.done ? (
        <div className={styles.clone}>
          <span>{S.clone.running(cloneOp.label)}</span>
          {cloneOp.percent !== null ? <progress max={100} value={cloneOp.percent} /> : null}
          <span className={styles.phase}>{cloneOp.phase}</span>
          <Button onClick={() => void cancelClone()}>{S.toolbar.cancel}</Button>
        </div>
      ) : null}
      <div className={styles.recentHeader}>
        <select
          aria-label={S.home.kindFilter}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="all">{S.home.all}</option>
          <option value="folder">{S.home.folder}</option>
          <option value="repo">{S.home.repo}</option>
          <option value="group">{S.group.kind}</option>
        </select>
        <input
          ref={searchRef}
          aria-label={S.home.search}
          className={styles.search}
          placeholder={S.home.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {showGroups ? (
        <section aria-label={S.group.section}>
          <h2 className={styles.recentTitle}>
            {S.group.section} <span className={styles.count}>{shownGroups.length}</span>
          </h2>
          {shownGroups.length === 0 ? (
            <div className={styles.empty}>{query ? S.home.noMatches : S.group.empty}</div>
          ) : (
            <ul className={styles.list}>
              {shownGroups.map((g) => {
                const key = groupKey(g.id);
                const lost = g.members.filter((m) => m.state !== 'present').length;
                return (
                  <li key={g.id} className={styles.item}>
                    <button
                      type="button"
                      disabled={isOpening}
                      className={styles.entry}
                      onClick={() => openGroup(g)}
                      title={g.members.map((m) => `${m.alias} — ${m.path}`).join('\n')}
                    >
                      <span className={styles.name}>
                        <span aria-hidden="true" className={styles.typeIcon}>
                          {GROUP_GLYPH}
                        </span>
                        <span className={styles.entryName}>{g.name}</span>
                        <span className={styles.badges}>
                          <span className={styles.kind}>{S.group.kind}</span>
                          {lost > 0 ? (
                            <span className={styles.kind}>{S.group.state.missing}</span>
                          ) : null}
                          {Object.values(sessions).some((session) => session.path === key) ? (
                            <span className={styles.opened}>{S.home.opened}</span>
                          ) : null}
                        </span>
                      </span>
                      <span className={styles.path}>
                        {S.group.memberCount(g.members.length)} ·{' '}
                        {g.members.map((m) => m.alias).join(', ')}
                      </span>
                      <span className={styles.time}>
                        {g.lastOpenedAt
                          ? formatDateTime(Math.floor((g.lastOpenedAt ?? 0) / 1000))
                          : ''}
                      </span>
                    </button>
                    <span className={styles.itemActions}>
                      <button
                        type="button"
                        className={styles.small}
                        onClick={() => void updateGroup(g.id, { pinned: !g.pinned })}
                        aria-label={`${g.pinned ? S.home.unpin : S.home.pin}: ${g.name}`}
                        aria-pressed={g.pinned}
                        title={g.pinned ? S.home.unpin : S.home.pin}
                      >
                        {g.pinned ? '★' : '☆'}
                      </button>
                      <button
                        type="button"
                        className={styles.small}
                        onClick={() => setGroupDialog({ mode: 'edit', id: g.id })}
                        aria-label={S.group.editNamed(g.name)}
                        title={S.group.edit}
                      >
                        ✎
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
      {sections.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <h2 className={styles.recentTitle}>
            {section.title} <span className={styles.count}>{section.entries.length}</span>
          </h2>
          {section.entries.length === 0 ? (
            <div className={styles.empty}>
              {query || kind !== 'all' ? S.home.noMatches : section.empty}
            </div>
          ) : (
            <ul className={styles.list}>
              {section.entries.map((r) => (
                <li key={r.path} className={styles.item}>
                  <button
                    type="button"
                    disabled={isOpening}
                    className={styles.entry}
                    onClick={() => open(r)}
                    title={r.path}
                  >
                    <span className={styles.name}>
                      <span aria-hidden="true" className={styles.typeIcon}>
                        {r.kind === 'folder' ? <Icon name="folder" /> : null}
                      </span>
                      <span className={styles.entryName}>{r.name}</span>
                      <span className={styles.badges}>
                        <span className={styles.kind}>
                          {r.kind === 'folder' ? S.home.folder : S.home.repo}
                        </span>
                        {Object.values(sessions).some((session) => session.path === r.path) ? (
                          <span className={styles.opened}>{S.home.opened}</span>
                        ) : null}
                      </span>
                    </span>
                    <span className={styles.path}>{r.path}</span>
                    <span className={styles.time}>
                      {formatDateTime(Math.floor((r.lastOpenedAt ?? 0) / 1000))}
                    </span>
                  </button>
                  <span className={styles.itemActions}>
                    <button
                      type="button"
                      className={styles.small}
                      onClick={() => void pinRecent(r.path, !r.pinned)}
                      aria-label={`${r.pinned ? S.home.unpin : S.home.pin}: ${r.name}`}
                      aria-pressed={r.pinned}
                      title={r.pinned ? S.home.unpin : S.home.pin}
                    >
                      {r.pinned ? '★' : '☆'}
                    </button>
                    <button
                      type="button"
                      className={styles.small}
                      onClick={() => void removeRecent(r.path)}
                      aria-label={`${S.home.remove}: ${r.name}`}
                      title={S.home.remove}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <div className={styles.hint}>{S.home.dropHint}</div>
      {dialogs.element}
    </div>
  );
}
