import type { HostKind, SshKeyInfo } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { useModal } from '../../components/use-modal';
import { useAppStore } from '../../store';
import styles from './hosting.module.css';

/** SSH 키 (AU-04): 목록·공개 키 복사·ed25519 생성·호스팅 등록 페이지 열기 */
export function SshKeysDialog() {
  const open = useAppStore((s) => s.appDialog === 'sshKeys');
  const setDialog = useAppStore((s) => s.setAppDialog);
  const list = useAppStore((s) => s.sshKeys);
  const keygen = useAppStore((s) => s.sshKeygen);
  const urlsOf = useAppStore((s) => s.hostingUrls);
  const openUrl = useAppStore((s) => s.openUrl);
  const accounts = useAppStore((s) => s.hostingAccounts);
  const lastError = useAppStore((s) => s.lastError);
  const ref = useModal(open);
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [name, setName] = useState('id_ed25519_mgit');
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      void list().then(setKeys);
    }
  }, [open, list]);

  if (!open) {
    return null;
  }
  const t = S.hosting;
  const close = () => setDialog(null);

  /** 공개 키를 클립보드로 */
  const copy = async (k: SshKeyInfo) => {
    try {
      await navigator.clipboard.writeText(k.publicKey);
      setCopied(k.path);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // 무시
    }
  };

  /** 키 생성 뒤 목록 갱신 */
  const generate = async () => {
    setBusy(true);
    const k = await keygen(name, comment, passphrase);
    setBusy(false);
    if (k) {
      setKeys(await list());
      setPassphrase('');
    }
  };

  /** 호스팅 SSH 키 등록 페이지 */
  const register = async (kind: HostKind, host: string) => {
    const u = await urlsOf(kind, host);
    if (u) {
      void openUrl(u.sshKeysUrl);
    }
  };
  const targets = accounts.length
    ? accounts.map((a) => ({ kind: a.kind, host: a.host, label: `${a.kind} · ${a.host}` }))
    : [
        { kind: 'github' as const, host: 'github.com', label: 'GitHub' },
        { kind: 'gitlab' as const, host: 'gitlab.com', label: 'GitLab' },
      ];

  return (
    <dialog ref={ref} className={styles.dialog} onClose={close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{t.sshTitle}</span>
          <span className={styles.spacer} />
          <Button onClick={close}>{t.close}</Button>
        </header>
        {lastError ? <div className={styles.error}>{lastError}</div> : null}
        {keys.length === 0 ? (
          <div className={styles.hint}>{t.sshNone}</div>
        ) : (
          <ul className={styles.list}>
            {keys.map((k) => (
              <li key={k.path} className={styles.item}>
                <span className={styles.badge}>{k.kind}</span>
                <span className={styles.grow} title={k.publicKey}>
                  <span className={styles.mono}>{k.path}</span>
                  {k.comment ? <span className={styles.muted}> · {k.comment}</span> : null}
                </span>
                <Button onClick={() => void copy(k)}>
                  {copied === k.path ? t.copied : t.copy}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.generate}</h3>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.keyName}
              <input
                className={styles.input}
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t.keyComment}
              <input
                className={styles.input}
                value={comment}
                placeholder="you@example.com"
                disabled={busy}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t.passphrase}
              <input
                className={styles.input}
                type="password"
                value={passphrase}
                autoComplete="new-password"
                disabled={busy}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
            <Button
              variant="primary"
              disabled={busy || name.trim() === ''}
              onClick={() => void generate()}
            >
              {t.generate}
            </Button>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.registerTitle}</h3>
          <div className={styles.row}>
            {targets.map((x) => (
              <Button key={x.label} onClick={() => void register(x.kind, x.host)}>
                {t.registerAt(x.label)}
              </Button>
            ))}
          </div>
        </section>
      </div>
    </dialog>
  );
}
