import type { BackupRecord } from '@mgit/ipc';
import { Button, formatDateTime, S } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { str, useDialogs } from '../../components/use-dialogs';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import { BACKUP_KEEP_DAYS, FILE_BACKUP_LIMIT } from '../../store/session-store';
import h from '../history/history.module.css';
import styles from './FileBackupsDialog.module.css';

/** 하루 (밀리초) */
const DAY_MS = 86_400_000;

/** "며칠보다 오래된" 입력을 날 수로. 0 이상의 정수가 아니면 null */
export function parsePruneDays(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** 날 수 → 이보다 먼저 만든 사본을 지울 기준 시각 (epoch 밀리초). 0 이면 전부다 */
export function pruneBefore(days: number, now: number): number {
  return days === 0 ? Number.MAX_SAFE_INTEGER : now - days * DAY_MS;
}

/** 기준 시각보다 먼저 만든 사본 수 (보이는 목록 기준) */
export function pruneCount(backups: readonly BackupRecord[], before: number): number {
  return backups.filter((b) => b.savedAt < before).length;
}

/**
 * 저장소 상대 경로를 폴더 부분(끝의 `/` 까지)과 파일 이름으로 나눈다. 줄이 좁으면 폴더 부분부터 줄임표로 줄이고 파일
 * 이름은 끝까지 남긴다 (#22)
 */
export function splitBackupPath(relPath: string): { dir: string; name: string } {
  const at = relPath.lastIndexOf('/');
  return at < 0
    ? { dir: '', name: relPath }
    : { dir: relPath.slice(0, at + 1), name: relPath.slice(at + 1) };
}

/**
 * 폐기 백업 (CHG-04, #26): 되돌리기로 버린 파일의 사본을 작업 트리로 복구하거나 지운다. 복구는 현재 파일을 덮어쓰고,
 * 지우기는 되돌릴 수 없으므로 둘 다 위험 확인을 받는다. 머리의 "오래된 백업 삭제…" 는 날 수(처음 값은 보관 기간)를 받아
 * 그보다 오래된 사본을 한꺼번에 지운다 — 지울 수를 확인 창에 보이고, 0 개면 확인을 끈다
 */
export function FileBackupsDialog() {
  const s = useSession((st) => ({
    backups: st.fileBackups,
    close: st.closeFileBackups,
    restore: st.restoreFileBackup,
    deleteBackups: st.deleteFileBackups,
    busy: st.busy,
  }));
  const dialogs = useDialogs();
  const ref = useModal(s.backups !== null);
  if (s.backups === null || s.backups === undefined) {
    return null;
  }
  const backups = s.backups;

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

  /** 사본 하나를 확인을 받고 지운다 (되돌릴 수 없다) */
  const remove = async (id: number, path: string) => {
    const ok = await dialogs.confirm({
      title: S.safety.fileBackupDeleteTitle(path),
      message: S.safety.fileBackupDeleteMessage,
      confirmLabel: S.safety.fileBackupDeleteConfirm,
      danger: true,
    });
    if (ok) {
      await s.deleteBackups({ ids: [id] });
    }
  };

  /**
   * 오래된 사본을 한꺼번에 지운다: 날 수를 받고(입력할 때마다 지울 수를 보인다) 확인하면 그 기준보다 먼저 만든 사본을
   * 모두 지운다. 목록이 상한까지 차 있으면 보이지 않는 사본도 지워질 수 있어 "이상" 으로 적는다
   */
  const prune = async () => {
    const now = Date.now();
    const full = backups.length >= FILE_BACKUP_LIMIT;
    const countOf = (values: Readonly<Record<string, string | boolean>>) => {
      const days = parsePruneDays(typeof values.days === 'string' ? values.days : '');
      return days === null ? null : pruneCount(backups, pruneBefore(days, now));
    };
    const values = await dialogs.prompt({
      title: S.safety.fileBackupsPruneTitle,
      message: S.safety.fileBackupsPruneMessage,
      danger: true,
      fields: [
        { key: 'days', label: S.safety.fileBackupsPruneDays, initial: String(BACKUP_KEEP_DAYS) },
      ],
      validate: (v) => {
        const n = countOf(v);
        if (n === null) {
          return S.safety.fileBackupsPruneInvalid;
        }
        return n === 0 && !full ? S.safety.fileBackupsPruneNone : null;
      },
      notice: (v) => {
        const n = countOf(v);
        return n === null ? null : S.safety.fileBackupsPruneCount(n, full);
      },
      confirmLabel: S.safety.fileBackupDeleteConfirm,
    });
    const days = values ? parsePruneDays(str(values, 'days')) : null;
    if (days !== null) {
      await s.deleteBackups({ beforeMs: pruneBefore(days, now) });
    }
  };

  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{S.safety.fileBackupsTitle}</span>
          <span className={h.spacer} />
          <Button disabled={s.busy || backups.length === 0} onClick={() => void prune()}>
            {S.safety.fileBackupsPrune}
          </Button>
          <Button onClick={s.close}>{S.history.close}</Button>
        </header>
        <ActionErrorBar />
        <div className={h.muted}>
          {S.safety.fileBackupsHint} {S.safety.fileBackupsKeep(BACKUP_KEEP_DAYS)}
        </div>
        {backups.length === 0 ? (
          <div className={h.empty}>{S.safety.fileBackupsEmpty}</div>
        ) : (
          <ul className={h.list}>
            {backups.map((b) => {
              const { dir, name } = splitBackupPath(b.relPath);
              return (
                <li key={b.id} className={styles.item}>
                  {/* 좁으면 폴더 부분부터 줄인다. 전체 경로는 툴팁과 읽어 주는 글자(이어 붙은 두 칸)로 */}
                  <span className={styles.path} title={b.relPath}>
                    {dir ? <span className={styles.dir}>{dir}</span> : null}
                    <span className={styles.name}>{name}</span>
                  </span>
                  <span className={styles.time}>
                    {formatDateTime(Math.floor(b.savedAt / 1000))}
                  </span>
                  <span className={styles.reason} title={b.reason}>
                    {b.reason}
                  </span>
                  <Button disabled={s.busy} onClick={() => void restore(b.id, b.relPath)}>
                    {S.safety.fileBackupRestore}
                  </Button>
                  <Button disabled={s.busy} onClick={() => void remove(b.id, b.relPath)}>
                    {S.safety.fileBackupDelete}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {dialogs.element}
    </dialog>
  );
}
