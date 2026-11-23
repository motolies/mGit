import { Button, formatDateTime, S, shortHash } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import { useFolderDialogTarget } from './folder-target';
import styles from './history.module.css';

/**
 * 파일 히스토리 (DIFF-05): `--follow` 로 이름 변경까지 따라간 commit 목록. 폴더 탭에서 열면(W13) 머리에 대상 저장소를
 * 보이고, 해시를 누르면 그래프 대신 로그 선택과 커밋 diff 탭으로 간다
 */
export function FileHistoryDialog() {
  const s = useSession((st) => ({
    h: st.fileHistory,
    close: st.closeFileHistory,
    openCommitFile: st.openCommitFile,
    jump: st.jumpToCommit,
    openBlame: st.openBlame,
  }));
  const folder = useFolderDialogTarget();
  const ref = useModal(s.h !== null);
  const h = s.h;
  if (!h) {
    return null;
  }

  /** 그 commit 으로 이동하고 당시 경로의 diff 를 연다 (폴더 탭은 로그 선택 + 커밋 diff 탭) */
  const show = async (oid: string, path: string) => {
    s.close();
    if (folder) {
      folder.openCommitFile(oid, path);
      return;
    }
    await s.jump(oid);
    await s.openCommitFile(oid, path);
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={s.close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{S.history.historyTitle(h.path)}</span>
          {folder ? (
            <span className={styles.muted}>{S.history.inRepo(folder.repoName)}</span>
          ) : null}
          <span className={styles.muted}>{S.history.limit(h.entries.length)}</span>
          <span className={styles.spacer} />
          <Button onClick={s.close}>{S.history.close}</Button>
        </header>
        <ActionErrorBar />
        {h.loading ? (
          <div className={styles.empty}>{S.history.loading}</div>
        ) : h.entries.length === 0 ? (
          <div className={styles.empty}>{S.history.empty}</div>
        ) : (
          <ul className={styles.list}>
            {h.entries.map((e) => (
              <li key={e.oid} className={styles.item}>
                <button
                  type="button"
                  className={styles.link}
                  title={e.oid}
                  onClick={() => void show(e.oid, e.path)}
                >
                  {shortHash(e.oid)}
                </button>
                <span className={styles.muted}>{formatDateTime(e.authorTime ?? 0)}</span>
                <span className={styles.subject} title={e.authorName}>
                  {e.authorName}
                </span>
                <span className={styles.subject} title={e.subject}>
                  {e.subject}
                  {e.path !== h.path ? (
                    <span className={styles.muted}> {S.history.renamedFrom(e.path)}</span>
                  ) : null}
                </span>
                <Button
                  onClick={() => {
                    s.close();
                    void s.openBlame(e.path, e.oid);
                  }}
                >
                  blame
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
