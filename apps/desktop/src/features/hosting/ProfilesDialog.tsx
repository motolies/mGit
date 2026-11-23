import type { Profile } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { getSessionStore, useAppStore } from '../../store';
import styles from './hosting.module.css';

/** 빈 프로필 */
function blank(): Profile {
  return { id: '', name: '', userName: '', userEmail: '', signingKey: null, hostingAccount: null };
}

/** 작성자 프로필 (AU-06): 이름·이메일·서명 키·계정 묶음을 편집하고 현재 저장소에 적용 */
export function ProfilesDialog() {
  const open = useAppStore((s) => s.appDialog === 'profiles');
  const setDialog = useAppStore((s) => s.setAppDialog);
  const profiles = useAppStore((s) => s.profiles);
  const load = useAppStore((s) => s.loadProfiles);
  const save = useAppStore((s) => s.saveProfiles);
  const accounts = useAppStore((s) => s.hostingAccounts);
  const loadAccounts = useAppStore((s) => s.loadHostingAccounts);
  const activeId = useAppStore((s) => s.activeSessionId);
  const activeKind = useAppStore((s) =>
    s.activeSessionId === null ? null : (s.sessions[s.activeSessionId]?.kind ?? null),
  );
  const lastError = useAppStore((s) => s.lastError);
  const ref = useModal(open);
  const [list, setList] = useState<Profile[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open) {
      void load();
      void loadAccounts();
    }
  }, [open, load, loadAccounts]);
  // 저장된 목록이 바뀌면(저장 직후 포함) 편집본을 맞춘다
  useEffect(() => {
    setList(profiles);
    setDirty(false);
  }, [profiles]);

  if (!open) {
    return null;
  }
  const t = S.hosting;
  const close = () => setDialog(null);
  const canApply = activeId !== null && activeKind === 'repo';

  /** 항목 하나 수정 */
  const patch = (i: number, p: Partial<Profile>) => {
    setList((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));
    setDirty(true);
  };

  /** 저장된 프로필을 현재 저장소에 적용 */
  const apply = (id: string) => {
    const store = activeId === null ? undefined : getSessionStore(activeId);
    if (store) {
      void store.getState().applyProfile(id);
    }
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{t.profilesTitle}</span>
          <span className={styles.spacer} />
          <Button
            onClick={() => {
              setList((prev) => [...prev, blank()]);
              setDirty(true);
            }}
          >
            {t.add}
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void save(list)}>
            {t.save}
          </Button>
          <Button onClick={close}>{t.close}</Button>
        </header>
        {lastError ? <div className={styles.error}>{lastError}</div> : null}
        <ActionErrorBar />
        {list.length === 0 ? (
          <div className={styles.hint}>{t.noProfiles}</div>
        ) : (
          <div>
            <div className={`${styles.profileRow} ${styles.muted}`}>
              <span>{t.profileName}</span>
              <span>{t.userName}</span>
              <span>{t.userEmail}</span>
              <span>{t.signingKey}</span>
              <span>{t.account}</span>
              <span />
            </div>
            {list.map((p, i) => (
              <div key={p.id || `new-${i}`} className={styles.profileRow}>
                <input
                  className={styles.input}
                  value={p.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <input
                  className={styles.input}
                  value={p.userName}
                  onChange={(e) => patch(i, { userName: e.target.value })}
                />
                <input
                  className={styles.input}
                  value={p.userEmail}
                  onChange={(e) => patch(i, { userEmail: e.target.value })}
                />
                <input
                  className={styles.input}
                  value={p.signingKey ?? ''}
                  onChange={(e) => patch(i, { signingKey: e.target.value || null })}
                />
                <select
                  className={styles.select}
                  value={p.hostingAccount ?? ''}
                  onChange={(e) => patch(i, { hostingAccount: e.target.value || null })}
                >
                  <option value="">{t.none}</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.user} · {a.host}
                    </option>
                  ))}
                </select>
                <span className={styles.profileActions}>
                  <Button
                    disabled={!canApply || !p.id || dirty}
                    title={dirty ? t.applyHint : undefined}
                    onClick={() => apply(p.id)}
                  >
                    {t.apply}
                  </Button>
                  <Button
                    onClick={() => {
                      setList((prev) => prev.filter((_, j) => j !== i));
                      setDirty(true);
                    }}
                  >
                    {t.delete}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}
