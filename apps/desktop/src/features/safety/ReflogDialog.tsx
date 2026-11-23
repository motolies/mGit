import { formatDateTime, isImeKey, S, shortHash } from '@mgit/ui';
import { useEffect, useRef, useState } from 'react';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { str, useDialogs } from '../../components/use-dialogs';
import { useSession } from '../../store';
import { branchNameField } from '../branch/branch-name';
import styles from './ReflogDialog.module.css';

/** reflog 뷰어 (AD-02): ref 입력 → 항목 목록 → 시점을 새 branch 로 복원 */
export function ReflogDialog() {
  const s = useSession((st) => ({
    open: st.reflogOpen,
    reference: st.reflogRef,
    entries: st.reflog,
    busy: st.busy,
    setOpen: st.setReflogOpen,
    load: st.loadReflog,
    restore: st.reflogRestore,
    jumpToCommit: st.jumpToCommit,
  }));
  const dialogs = useDialogs();
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(s.reference);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (s.open && !el.open) {
      if (typeof el.showModal === 'function') {
        el.showModal();
      } else {
        el.setAttribute('open', '');
      }
    } else if (!s.open && el.open) {
      el.close();
    }
  }, [s.open]);

  if (!s.open) {
    return null;
  }

  /** 항목을 새 branch 로 */
  const restore = async (oid: string, selector: string) => {
    const v = await dialogs.prompt({
      title: S.safety.restoreTitle,
      message: `${selector} · ${shortHash(oid)}`,
      fields: [branchNameField({ key: 'name', label: S.safety.restoreName, required: true })],
      confirmLabel: S.dialog.create,
    });
    if (v) {
      await s.restore(oid, str(v, 'name'));
    }
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onClose={() => s.setOpen(false)}
      onCancel={() => s.setOpen(false)}
    >
      <div className={styles.box}>
        <div className={styles.header}>
          <span className={styles.title}>{S.safety.reflogTitle(s.reference || 'HEAD')}</span>
          <input
            className={styles.input}
            placeholder={S.safety.reflogRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeKey(e)) {
                e.preventDefault();
                void s.load(text);
              }
            }}
          />
        </div>
        <ActionErrorBar />
        {s.entries.length === 0 ? (
          <div className={styles.empty}>{S.safety.reflogEmpty}</div>
        ) : (
          <ul className={styles.list}>
            {s.entries.map((e) => (
              <li key={e.selector} className={styles.item}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => void s.jumpToCommit(e.oid)}
                  title={e.oid}
                >
                  <span className={styles.selector}>{e.selector}</span>
                  <span className={styles.hash}>{shortHash(e.oid)}</span>
                  <span className={styles.subject}>{e.subject}</span>
                  <span className={styles.time}>{formatDateTime(e.time ?? 0)}</span>
                </button>
                <button
                  type="button"
                  className={styles.small}
                  disabled={s.busy}
                  onClick={() => void restore(e.oid, e.selector)}
                  title={S.safety.reflogRestore}
                >
                  ⎇
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dialogs.element}
    </dialog>
  );
}
