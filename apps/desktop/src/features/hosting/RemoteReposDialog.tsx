import type { HostedRepo } from '@mgit/ipc';
import { Button, isImeKey, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { useModal } from '../../components/use-modal';
import { useAppStore } from '../../store';
import { batchCloneFlow } from '../home/batch-clone';
import { cloneFlow } from '../home/repo-flows';
import styles from './hosting.module.css';

/** 원격 저장소 탐색 → clone (HO-01) */
export function RemoteReposDialog() {
  const open = useAppStore((s) => s.appDialog === 'remoteRepos');
  const setDialog = useAppStore((s) => s.setAppDialog);
  const accounts = useAppStore((s) => s.hostingAccounts);
  const loadAccounts = useAppStore((s) => s.loadHostingAccounts);
  const fetchRepos = useAppStore((s) => s.hostingRepos);
  const pickDirectory = useAppStore((s) => s.pickDirectory);
  const cloneRepository = useAppStore((s) => s.cloneRepository);
  const lastError = useAppStore((s) => s.lastError);
  const dialogs = useDialogs();
  const ref = useModal(open);
  const [accountId, setAccountId] = useState('');
  const [search, setSearch] = useState('');
  const [repos, setRepos] = useState<HostedRepo[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [protocol, setProtocol] = useState<'https' | 'ssh'>('https');
  // 여러 저장소 복제로 넘길 저장소 (전체 이름). 계정을 바꾸면 비운다
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const cloneRepositories = useAppStore((s) => s.cloneRepositories);
  const notice = useAppStore((s) => s.notice);

  useEffect(() => {
    if (open) {
      void loadAccounts();
    }
  }, [open, loadAccounts]);
  // 계정이 생기면 첫 계정을 고른다
  useEffect(() => {
    if (open && accountId === '' && accounts[0]) {
      setAccountId(accounts[0].id);
    }
  }, [open, accounts, accountId]);

  /** 한 쪽 읽기. `page` 가 1 이면 목록을 새로 채운다 */
  const load = async (page: number) => {
    if (!accountId) {
      return;
    }
    setLoading(true);
    const r = await fetchRepos(accountId, page, search);
    setLoading(false);
    if (!r) {
      return;
    }
    setRepos((prev) => (page === 1 ? r.repos : [...prev, ...r.repos]));
    setNextPage(r.nextPage ?? null);
  };
  // 계정을 바꾸면 첫 쪽부터
  // biome-ignore lint/correctness/useExhaustiveDependencies: 계정 변경 때만 다시 읽는다
  useEffect(() => {
    if (open && accountId) {
      setRepos([]);
      setPicked(new Set());
      void load(1);
    }
  }, [open, accountId]);

  if (!open) {
    return null;
  }
  const t = S.hosting;
  const close = () => setDialog(null);

  /** 저장소의 clone URL (고른 프로토콜) */
  const urlOf = (r: HostedRepo) => (protocol === 'ssh' ? r.sshUrl : r.cloneUrl);

  /** 고른 저장소를 clone 흐름으로 */
  const clone = async (r: HostedRepo) => {
    await cloneFlow(dialogs, { pickDirectory, cloneRepository }, urlOf(r));
  };

  /** 저장소 하나를 고르거나 푼다 (여러 저장소 복제 대상) */
  const togglePick = (fullName: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(fullName)) {
        next.add(fullName);
      }
      return next;
    });

  /** 고른 저장소들의 URL 로 여러 저장소 복제 흐름을 연다 (목록 순서) */
  const cloneMany = async () => {
    const text = repos
      .filter((r) => picked.has(r.fullName))
      .map(urlOf)
      .join('\n');
    await batchCloneFlow(dialogs, { pickDirectory, cloneRepositories, notice }, { text });
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{t.reposTitle}</span>
          <select
            className={styles.select}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.user} · {a.host}
              </option>
            ))}
          </select>
          <input
            className={styles.input}
            value={search}
            placeholder={t.search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (isImeKey(e)) {
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                void load(1);
              }
            }}
          />
          <Button disabled={loading || !accountId} onClick={() => void load(1)}>
            {t.searchRun}
          </Button>
          <label className={styles.muted}>
            {t.protocol}{' '}
            <select
              className={styles.select}
              value={protocol}
              onChange={(e) => setProtocol(e.target.value === 'ssh' ? 'ssh' : 'https')}
            >
              <option value="https">https</option>
              <option value="ssh">ssh</option>
            </select>
          </label>
          <span className={styles.spacer} />
          <Button disabled={picked.size === 0} onClick={() => void cloneMany()}>
            {t.cloneSelected(picked.size)}
          </Button>
          <Button onClick={close}>{t.close}</Button>
        </header>
        {lastError ? <div className={styles.error}>{lastError}</div> : null}
        {accounts.length === 0 ? (
          <div className={styles.hint}>{t.noAccountHint}</div>
        ) : repos.length === 0 && !loading ? (
          <div className={styles.hint}>{t.noRepos}</div>
        ) : (
          <ul className={styles.list}>
            {repos.map((r) => (
              <li key={r.fullName} className={styles.item}>
                <input
                  type="checkbox"
                  aria-label={t.pick(r.fullName)}
                  checked={picked.has(r.fullName)}
                  onChange={() => togglePick(r.fullName)}
                />
                <span className={styles.grow} title={r.description ?? r.fullName}>
                  <span className={styles.mono}>{r.fullName}</span>
                  {r.description ? <span className={styles.muted}> · {r.description}</span> : null}
                </span>
                {r.private ? <span className={styles.badge}>{t.private}</span> : null}
                {r.fork ? <span className={styles.badge}>{t.fork}</span> : null}
                {r.updatedAt ? (
                  <span className={styles.muted}>{r.updatedAt.slice(0, 10)}</span>
                ) : null}
                <Button variant="primary" onClick={() => void clone(r)}>
                  {t.clone}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {loading ? <div className={styles.hint}>{t.loading}</div> : null}
        {nextPage !== null && !loading ? (
          <div className={styles.row}>
            <Button onClick={() => void load(nextPage)}>{t.nextPage}</Button>
          </div>
        ) : null}
        {dialogs.element}
      </div>
    </dialog>
  );
}
