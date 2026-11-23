import type { DeviceCodes, HostingUrls, HostKind, OauthConfig } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { useModal } from '../../components/use-modal';
import { useAppStore } from '../../store';

import styles from './hosting.module.css';

/** 종류별 기본 호스트 */
function defaultHost(kind: HostKind): string {
  return kind === 'github' ? 'github.com' : 'gitlab.com';
}

/** 호스팅 계정 (AU-05): PAT 또는 디바이스 플로우로 연결, OAuth App 설정 */
export function AccountsDialog() {
  const open = useAppStore((s) => s.appDialog === 'accounts');
  const setDialog = useAppStore((s) => s.setAppDialog);
  const accounts = useAppStore((s) => s.hostingAccounts);
  const load = useAppStore((s) => s.loadHostingAccounts);
  const addPat = useAppStore((s) => s.hostingAddPat);
  const deviceStart = useAppStore((s) => s.hostingDeviceStart);
  const deviceFinish = useAppStore((s) => s.hostingDeviceFinish);
  const remove = useAppStore((s) => s.hostingRemove);
  const oauthGet = useAppStore((s) => s.hostingOauthGet);
  const oauthSet = useAppStore((s) => s.hostingOauthSet);
  const urlsOf = useAppStore((s) => s.hostingUrls);
  const openUrl = useAppStore((s) => s.openUrl);
  const lastError = useAppStore((s) => s.lastError);
  const credentialTargets = useAppStore((s) => s.credentialTargets);
  const credentialForget = useAppStore((s) => s.credentialForget);
  const ref = useModal(open);
  const [kind, setKind] = useState<HostKind>('github');
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const [oauth, setOauth] = useState<OauthConfig>({ githubClientId: null, gitlabClientId: null });
  const [codes, setCodes] = useState<DeviceCodes | null>(null);
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState<HostingUrls | null>(null);
  const [forgetTarget, setForgetTarget] = useState('');

  useEffect(() => {
    if (open) {
      void load();
      void oauthGet().then(setOauth);
    }
  }, [open, load, oauthGet]);
  useEffect(() => {
    if (open) {
      void urlsOf(kind, host).then(setUrls);
    }
  }, [open, kind, host, urlsOf]);

  if (!open) {
    return null;
  }
  const t = S.hosting;
  const clientId = (kind === 'github' ? oauth.githubClientId : oauth.gitlabClientId) ?? '';
  const close = () => setDialog(null);

  /** PAT 로 추가 */
  const submitPat = async () => {
    setBusy(true);
    const a = await addPat(kind, host, token);
    setBusy(false);
    if (a) {
      setToken('');
    }
  };

  /** 디바이스 플로우: 코드 받기 → 브라우저 열기 → 승인 기다리기 */
  const startDevice = async () => {
    setBusy(true);
    const c = await deviceStart(kind, host);
    if (!c) {
      setBusy(false);
      return;
    }
    setCodes(c);
    void openUrl(c.verificationUriComplete ?? c.verificationUri);
    await deviceFinish(kind, host, c);
    setCodes(null);
    setBusy(false);
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{t.accountsTitle}</span>
          <span className={styles.spacer} />
          <Button onClick={close}>{t.close}</Button>
        </header>
        {lastError ? <div className={styles.error}>{lastError}</div> : null}

        {accounts.length === 0 ? (
          <div className={styles.hint}>{t.noAccounts}</div>
        ) : (
          <ul className={styles.list}>
            {accounts.map((a) => (
              <li key={a.id} className={styles.item}>
                <span className={styles.badge}>{a.kind}</span>
                <span className={styles.grow} title={a.id}>
                  {a.user}
                  {a.name ? ` (${a.name})` : ''} · {a.host}
                </span>
                {a.webUrl ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => void openUrl(a.webUrl ?? '')}
                  >
                    {a.host}
                  </button>
                ) : null}
                <Button onClick={() => void remove(a.id)}>{t.remove}</Button>
              </li>
            ))}
          </ul>
        )}

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.addTitle}</h3>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.kind}
              <select
                className={styles.select}
                value={kind}
                disabled={busy}
                onChange={(e) => {
                  const k = e.target.value as HostKind;
                  setKind(k);
                  setHost(defaultHost(k));
                }}
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </label>
            <label className={styles.field}>
              {t.host}
              <input
                className={styles.input}
                value={host}
                disabled={busy}
                onChange={(e) => setHost(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.token}
              <input
                className={styles.input}
                type="password"
                value={token}
                disabled={busy}
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <Button
              variant="primary"
              disabled={busy || token.trim() === ''}
              onClick={() => void submitPat()}
            >
              {t.addPat}
            </Button>
            {urls ? (
              <button
                type="button"
                className={styles.link}
                onClick={() => void openUrl(urls.tokenUrl)}
              >
                {t.tokenHelp}
              </button>
            ) : null}
          </div>
          <div className={styles.row}>
            {clientId ? (
              <Button disabled={busy} onClick={() => void startDevice()}>
                {t.device}
              </Button>
            ) : (
              <span className={styles.hint}>{t.deviceNoClient}</span>
            )}
          </div>
          {codes ? (
            <div className={styles.row}>
              <span className={styles.code}>{codes.userCode}</span>
              <span className={styles.hint}>{t.deviceCode}</span>
              <Button
                onClick={() => void openUrl(codes.verificationUriComplete ?? codes.verificationUri)}
              >
                {t.openBrowser}
              </Button>
              <span className={styles.muted}>{t.deviceWaiting}</span>
            </div>
          ) : null}
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.oauthTitle}</h3>
          <div className={styles.hint}>{t.oauthHint}</div>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.githubClientId}
              <input
                className={styles.input}
                value={oauth.githubClientId ?? ''}
                onChange={(e) => setOauth({ ...oauth, githubClientId: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              {t.gitlabClientId}
              <input
                className={styles.input}
                value={oauth.gitlabClientId ?? ''}
                onChange={(e) => setOauth({ ...oauth, gitlabClientId: e.target.value })}
              />
            </label>
            <Button onClick={() => void oauthSet(oauth)}>{t.save}</Button>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.credentialsTitle}</h3>
          <div className={styles.hint}>{t.credentialsHint}</div>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.credentialTarget}
              <input
                className={styles.input}
                list="mgit-credential-targets"
                value={forgetTarget}
                onChange={(e) => setForgetTarget(e.target.value)}
              />
              <datalist id="mgit-credential-targets">
                {credentialTargets.map((target) => (
                  <option key={target} value={target} />
                ))}
              </datalist>
            </label>
            <Button
              disabled={forgetTarget.trim() === ''}
              onClick={() =>
                void credentialForget(forgetTarget.trim()).then((ok) => {
                  if (ok) {
                    setForgetTarget('');
                  }
                })
              }
            >
              {t.credentialForget}
            </Button>
          </div>
        </section>
      </div>
    </dialog>
  );
}
