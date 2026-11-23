import { Button, S } from '@mgit/ui';
import { useEffect, useRef } from 'react';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { str, useDialogs } from '../../components/use-dialogs';
import { useSession } from '../../store';
import styles from './RemotesDialog.module.css';

/** 원격 관리 대화상자 (RM-01): 목록·추가·이름 변경·URL 변경·제거 */
export function RemotesDialog({ onClose }: { onClose: () => void }) {
  const s = useSession((st) => ({
    remotes: st.refs.remotes,
    busy: st.busy,
    add: st.remoteAdd,
    rename: st.remoteRename,
    remove: st.remoteRemove,
    setUrl: st.remoteSetUrl,
  }));
  const dialogs = useDialogs();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) {
      if (typeof el.showModal === 'function') {
        el.showModal();
      } else {
        el.setAttribute('open', '');
      }
    }
  }, []);

  /** 추가 */
  const add = async () => {
    const v = await dialogs.prompt({
      title: S.remote.addTitle,
      fields: [
        {
          key: 'name',
          label: S.remote.name,
          initial: s.remotes.length === 0 ? 'origin' : '',
          required: true,
        },
        { key: 'url', label: S.remote.url, required: true },
      ],
      confirmLabel: S.dialog.create,
    });
    if (v) {
      await s.add(str(v, 'name'), str(v, 'url'));
    }
  };

  /** 이름 변경 */
  const rename = async (name: string) => {
    const v = await dialogs.prompt({
      title: S.remote.rename,
      fields: [{ key: 'name', label: S.remote.name, initial: name, required: true }],
      confirmLabel: S.dialog.rename,
    });
    if (v) {
      await s.rename(name, str(v, 'name'));
    }
  };

  /** URL 변경 */
  const setUrl = async (name: string, url: string) => {
    const v = await dialogs.prompt({
      title: S.remote.setUrl,
      fields: [{ key: 'url', label: S.remote.url, initial: url, required: true }],
      confirmLabel: S.dialog.apply,
    });
    if (v) {
      await s.setUrl(name, str(v, 'url'));
    }
  };

  /** 제거 */
  const remove = async (name: string) => {
    const ok = await dialogs.confirm({
      title: S.remote.removeTitle(name),
      message: S.remote.removeMessage,
      confirmLabel: S.dialog.delete,
      danger: true,
    });
    if (ok) {
      await s.remove(name);
    }
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClose} onCancel={onClose}>
      <div className={styles.box}>
        <div className={styles.header}>
          <span className={styles.title}>{S.remote.dialogTitle}</span>
          <Button variant="primary" disabled={s.busy} onClick={() => void add()}>
            {S.remote.add}
          </Button>
        </div>
        <ActionErrorBar />
        {s.remotes.length === 0 ? (
          <div className={styles.empty}>{S.remote.empty}</div>
        ) : (
          <ul className={styles.list}>
            {s.remotes.map((r) => (
              <li key={r.name} className={styles.item}>
                <div className={styles.meta}>
                  <span className={styles.name}>{r.name}</span>
                  <span className={styles.url} title={r.fetchUrl}>
                    {r.fetchUrl}
                  </span>
                  {r.pushUrl ? (
                    <span className={styles.url} title={r.pushUrl}>
                      {S.remote.pushUrl(r.pushUrl)}
                    </span>
                  ) : null}
                </div>
                <div className={styles.actions}>
                  <Button disabled={s.busy} onClick={() => void rename(r.name)}>
                    {S.remote.rename}
                  </Button>
                  <Button disabled={s.busy} onClick={() => void setUrl(r.name, r.fetchUrl)}>
                    {S.remote.setUrl}
                  </Button>
                  <Button disabled={s.busy} onClick={() => void remove(r.name)}>
                    {S.remote.remove}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.footer}>
          <Button onClick={onClose}>{S.remote.close}</Button>
        </div>
      </div>
      {dialogs.element}
    </dialog>
  );
}
