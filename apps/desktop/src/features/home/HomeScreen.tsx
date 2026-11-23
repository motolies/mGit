import type { RecentEntry } from '@mgit/ipc';
import { Button, formatDateTime, S } from '@mgit/ui';
import { useEffect, useMemo, useState } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { useAppStore } from '../../store';
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
  const cancelClone = useAppStore((s) => s.cancelClone);
  const initRepository = useAppStore((s) => s.initRepository);
  const loadRecent = useAppStore((s) => s.loadRecent);
  const dialogs = useDialogs();
  const [query, setQuery] = useState('');

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === ''
      ? recent
      : recent.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [recent, query]);

  /** clone 흐름 (공용 흐름 함수) */
  const clone = () => cloneFlow(dialogs, { pickDirectory, cloneRepository });

  /** init 흐름 (공용 흐름 함수) */
  const init = () => initFlow(dialogs, { pickDirectory, templates, initRepository });

  /** 최근 항목 열기 (폴더면 폴더 탭) */
  const open = (r: RecentEntry) => {
    if (r.kind === 'folder') {
      void openFolderAt(r.path);
    } else {
      void openRepositoryAt(r.path);
    }
  };

  return (
    <div className={styles.home}>
      <div className={styles.actions}>
        <Button variant="primary" disabled={isOpening} onClick={() => void openRepository()}>
          {S.home.open}
        </Button>
        <Button
          disabled={isOpening || (cloneOp !== null && !cloneOp.done)}
          onClick={() => void clone()}
        >
          {S.home.clone}
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
        <span className={styles.recentTitle}>{S.home.recent}</span>
        <input
          className={styles.search}
          placeholder={S.home.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <div className={styles.empty}>{S.home.empty}</div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((r) => (
            <li key={r.path} className={styles.item}>
              <button type="button" className={styles.entry} onClick={() => open(r)} title={r.path}>
                <span className={styles.name}>
                  {r.pinned ? '★ ' : ''}
                  {r.name}
                  {r.kind === 'folder' ? (
                    <span className={styles.kind}>{S.home.folder}</span>
                  ) : null}
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
                  title={r.pinned ? S.home.unpin : S.home.pin}
                >
                  {r.pinned ? '☆' : '★'}
                </button>
                <button
                  type="button"
                  className={styles.small}
                  onClick={() => void removeRecent(r.path)}
                  title={S.home.remove}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.hint}>{S.home.dropHint}</div>
      {dialogs.element}
    </div>
  );
}
