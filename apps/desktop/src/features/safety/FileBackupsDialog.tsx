import { Button, formatDateTime, S } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useDialogs } from '../../components/use-dialogs';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import h from '../history/history.module.css';

/** 폐기 백업 (CHG-04): 되돌리기로 버린 파일의 사본을 작업 트리로 복구한다 */
export function FileBackupsDialog() {
  const s = useSession((st) => ({
    backups: st.fileBackups,
    close: st.closeFileBackups,
    restore: st.restoreFileBackup,
    busy: st.busy,
  }));
  const dialogs = useDialogs();
  const ref = useModal(s.backups !== null);
  if (s.backups === null || s.backups === undefined) {
    return null;
  }

  /** 현재 파일을 덮어쓰므로 확인을 받고 복구한다 */
  const restore = async (id: number, path: string) => {
    const ok = await dialogs.confirm({
      title: S.safety.fileBackupRestoreTitle(path),
      message: S.safety.fileBackupRestoreMessage,
      confirmLabel: S.safety.fileBackupRestore,
      danger: true,
    });
    if (ok) {
      await s.restore(id);
    }
  };

  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{S.safety.fileBackupsTitle}</span>
          <span className={h.spacer} />
          <Button onClick={s.close}>{S.history.close}</Button>
        </header>
        <ActionErrorBar />
        <div className={h.muted}>{S.safety.fileBackupsHint}</div>
        {s.backups.length === 0 ? (
          <div className={h.empty}>{S.safety.fileBackupsEmpty}</div>
        ) : (
          <ul className={h.list}>
            {s.backups.map((b) => (
              <li key={b.id} className={h.item}>
                <span className={h.subject} title={b.relPath}>
                  {b.relPath}
                </span>
                <span className={h.muted}>{formatDateTime(Math.floor(b.savedAt / 1000))}</span>
                <span className={h.muted}>{b.reason}</span>
                <Button disabled={s.busy} onClick={() => void restore(b.id, b.relPath)}>
                  {S.safety.fileBackupRestore}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dialogs.element}
    </dialog>
  );
}
