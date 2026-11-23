import { Button, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { ActionErrorBar, LastErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { externalKey, useAppStore, useSession } from '../../store';
import styles from './RepoSettingsDialog.module.css';

/** 저장소 설정 (REPO-07): 사용자·hook·.gitignore·최적화(AD-07)·얕은 복제(REPO-03)·서명 상태 */
export function RepoSettingsDialog() {
  const s = useSession((st) => ({
    settings: st.repoSettings,
    close: st.closeRepoSettings,
    saveUser: st.saveUser,
    saveGitignore: st.saveGitignore,
    enablePerf: st.enablePerf,
    unshallow: st.unshallow,
    busy: st.busy,
    repoPath: st.path,
    applyProfile: st.applyProfile,
    verifyCommand: st.verifyCommand,
    worktreeInitCommand: st.worktreeInitCommand,
    saveVerifyCommand: st.saveVerifyCommand,
    saveWorktreeInitCommand: st.saveWorktreeInitCommand,
    runVerify: st.runVerify,
    lfs: st.lfs,
    lfsInstall: st.lfsInstall,
    lfsTrack: st.lfsTrack,
    lfsUntrack: st.lfsUntrack,
    lfsLock: st.lfsLock,
    lfsUnlock: st.lfsUnlock,
  }));
  const openExternal = useAppStore((st) => st.openExternal);
  const openingExternal = useAppStore((st) => st.openingExternal);
  const profiles = useAppStore((st) => st.profiles);
  const loadProfiles = useAppStore((st) => st.loadProfiles);
  const setAppDialog = useAppStore((st) => st.setAppDialog);
  const [profileId, setProfileId] = useState('');
  const ref = useModal(s.settings !== null);
  const r = s.settings;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [ignore, setIgnore] = useState('');
  const [verifyCmd, setVerifyCmd] = useState('');
  const [initCmd, setInitCmd] = useState('');
  const [lfsPattern, setLfsPattern] = useState('');
  const [lfsLockPath, setLfsLockPath] = useState('');
  // 저장된 명령이 들어오면 입력란에 반영
  useEffect(() => {
    setVerifyCmd(s.verifyCommand ?? '');
  }, [s.verifyCommand]);
  useEffect(() => {
    setInitCmd(s.worktreeInitCommand ?? '');
  }, [s.worktreeInitCommand]);
  // 대화상자가 열릴 때, 또는 그 칸의 저장된 값이 바뀔 때만 입력란을 채운다.
  // 한 칸을 저장해 설정이 다시 와도 다른 칸의 미저장 입력은 그대로 둔다
  const opened = !!r;
  const savedName = r?.localUserName ?? '';
  const savedEmail = r?.localUserEmail ?? '';
  const savedIgnore = r?.gitignore ?? '';
  useEffect(() => {
    if (opened) {
      void loadProfiles();
    }
  }, [opened, loadProfiles]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 다시 열 때도 저장된 값으로 되돌린다
  useEffect(() => {
    setName(savedName);
  }, [opened, savedName]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 다시 열 때도 저장된 값으로 되돌린다
  useEffect(() => {
    setEmail(savedEmail);
  }, [opened, savedEmail]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 다시 열 때도 저장된 값으로 되돌린다
  useEffect(() => {
    setIgnore(savedIgnore);
  }, [opened, savedIgnore]);
  if (!r) {
    return null;
  }
  const t = S.repoSettings;
  return (
    <dialog ref={ref} className={styles.dialog} onClose={s.close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{t.title}</span>
          <span className={styles.spacer} />
          <Button onClick={s.close}>{t.close}</Button>
        </header>
        <ActionErrorBar />
        <LastErrorBar />

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.user}</h3>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.userName}
              <input
                className={styles.input}
                value={name}
                placeholder={r.userName ?? ''}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t.userEmail}
              <input
                className={styles.input}
                value={email}
                placeholder={r.userEmail ?? ''}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <Button
              variant="primary"
              disabled={s.busy}
              onClick={() => void s.saveUser(name, email)}
            >
              {t.save}
            </Button>
          </div>
          <div className={styles.hint}>{t.userHint}</div>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.profile}
              <select
                className={styles.input}
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
              >
                <option value="">{t.profilePick}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.userName} &lt;{p.userEmail}&gt;)
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={s.busy || !profileId} onClick={() => void s.applyProfile(profileId)}>
              {t.applyProfile}
            </Button>
            <Button onClick={() => setAppDialog('profiles')}>{t.manageProfiles}</Button>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.signing}</h3>
          <div className={styles.hint}>
            {t.signingInfo(r.signing.format, r.signing.signingKey ?? null, r.signing.commitSign)}
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>
            {t.hooks}
            {r.hooksPath ? <span className={styles.muted}> ({r.hooksPath})</span> : null}
          </h3>
          {r.hooks.length === 0 ? (
            <div className={styles.hint}>{t.noHooks}</div>
          ) : (
            <ul className={styles.list}>
              {r.hooks.map((h) => (
                <li key={h.name} className={styles.item}>
                  <span className={styles.mono}>{h.name}</span>
                  <span className={styles.muted}>{h.executable ? '' : t.notExecutable}</span>
                  <Button
                    disabled={openingExternal.includes(externalKey('editor', h.path))}
                    onClick={() => void openExternal('editor', h.path)}
                  >
                    {t.openHook}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>.gitignore</h3>
          <textarea
            className={styles.textarea}
            value={ignore}
            spellCheck={false}
            onChange={(e) => setIgnore(e.target.value)}
          />
          <div className={styles.row}>
            <Button
              variant="primary"
              disabled={s.busy || ignore === (r.gitignore ?? '')}
              onClick={() => void s.saveGitignore(ignore)}
            >
              {t.saveGitignore}
            </Button>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.perf}</h3>
          <div className={styles.hint}>
            {t.perfStatus(r.perf.trackedFiles, r.perf.fsmonitor, r.perf.untrackedCache)}
          </div>
          {r.perf.fsmonitor && r.perf.untrackedCache ? null : (
            <div className={styles.row}>
              <Button disabled={s.busy} onClick={() => void s.enablePerf()}>
                {S.graph.perf.enable}
              </Button>
            </div>
          )}
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t.commands}</h3>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.verifyCommand}
              <input
                className={styles.input}
                value={verifyCmd}
                placeholder="pnpm test"
                onChange={(e) => setVerifyCmd(e.target.value)}
              />
            </label>
            <Button disabled={s.busy} onClick={() => void s.saveVerifyCommand(verifyCmd)}>
              {t.save}
            </Button>
            <Button disabled={s.busy || !s.verifyCommand} onClick={() => void s.runVerify()}>
              {t.runVerify}
            </Button>
          </div>
          <div className={styles.hint}>{t.verifyHint}</div>
          <div className={styles.row}>
            <label className={styles.field}>
              {t.initCommand}
              <input
                className={styles.input}
                value={initCmd}
                placeholder="pnpm install"
                onChange={(e) => setInitCmd(e.target.value)}
              />
            </label>
            <Button disabled={s.busy} onClick={() => void s.saveWorktreeInitCommand(initCmd)}>
              {t.save}
            </Button>
          </div>
          <div className={styles.hint}>{t.initHint}</div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>Git LFS</h3>
          {!s.lfs ? (
            <div className={styles.hint}>{S.history.loading}</div>
          ) : !s.lfs.installed ? (
            <div className={styles.hint}>{t.lfsNotInstalled}</div>
          ) : (
            <>
              <div className={styles.hint}>
                {t.lfsVersion(s.lfs.version ?? '')} ·{' '}
                {s.lfs.configured ? t.lfsConfigured : t.lfsNotConfigured}
              </div>
              {!s.lfs.configured ? (
                <div className={styles.row}>
                  <Button disabled={s.busy} onClick={() => void s.lfsInstall()}>
                    {t.lfsInstall}
                  </Button>
                </div>
              ) : null}
              <div className={styles.row}>
                <label className={styles.field}>
                  {t.lfsPattern}
                  <input
                    className={styles.input}
                    value={lfsPattern}
                    placeholder="*.psd"
                    onChange={(e) => setLfsPattern(e.target.value)}
                  />
                </label>
                <Button
                  disabled={s.busy || !lfsPattern.trim()}
                  onClick={() => {
                    void s.lfsTrack(lfsPattern.trim());
                    setLfsPattern('');
                  }}
                >
                  {t.lfsTrack}
                </Button>
              </div>
              <ul className={styles.lfsList}>
                {s.lfs.patterns.map((p) => (
                  <li key={p} className={styles.lfsItem}>
                    <span className={styles.mono}>{p}</span>
                    <Button disabled={s.busy} onClick={() => void s.lfsUntrack(p)}>
                      {t.lfsUntrack}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className={styles.hint}>{t.lfsFiles(s.lfs.files.length)}</div>
              <ul className={styles.lfsList}>
                {s.lfs.files.slice(0, 30).map((f) => (
                  <li key={f.path} className={styles.lfsItem}>
                    <span className={styles.mono}>{f.path}</span>
                    {f.full ? null : <span className={styles.hint}>{t.lfsPointer}</span>}
                    <Button disabled={s.busy} onClick={() => void s.lfsLock(f.path)}>
                      {t.lfsLock}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className={styles.hint}>{t.lfsLocks}</div>
              <ul className={styles.lfsList}>
                {s.lfs.locks.map((l) => (
                  <li key={l.id || l.path} className={styles.lfsItem}>
                    <span className={styles.mono}>{l.path}</span>
                    <span className={styles.hint}>{l.owner}</span>
                    <Button disabled={s.busy} onClick={() => void s.lfsUnlock(l.path, false)}>
                      {t.lfsUnlock}
                    </Button>
                    <Button disabled={s.busy} onClick={() => void s.lfsUnlock(l.path, true)}>
                      {t.lfsUnlockForce}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className={styles.row}>
                <label className={styles.field}>
                  {t.lfsLockPath}
                  <input
                    className={styles.input}
                    value={lfsLockPath}
                    onChange={(e) => setLfsLockPath(e.target.value)}
                  />
                </label>
                <Button
                  disabled={s.busy || !lfsLockPath.trim()}
                  onClick={() => {
                    void s.lfsLock(lfsLockPath.trim());
                    setLfsLockPath('');
                  }}
                >
                  {t.lfsLock}
                </Button>
              </div>
              {s.lfs.locksError ? (
                <div className={styles.hint}>{t.lfsLocksError(s.lfs.locksError)}</div>
              ) : null}
            </>
          )}
        </section>

        {r.shallow ? (
          <section className={styles.section}>
            <h3 className={styles.heading}>{t.shallow}</h3>
            <div className={styles.hint}>{t.shallowHint}</div>
            <div className={styles.row}>
              <Button disabled={s.busy} onClick={() => void s.unshallow()}>
                {t.unshallow}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </dialog>
  );
}
