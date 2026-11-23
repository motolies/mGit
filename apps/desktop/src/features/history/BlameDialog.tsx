import { Button, formatDateTime, S, shortHash } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import { useFolderDialogTarget } from './folder-target';
import styles from './history.module.css';

/**
 * blame 뷰어 (DIFF-04): 줄마다 commit·작성자, 해시 클릭 → 그래프 이동, ← 로 직전 시점. 폴더 탭에서 열면(W13) 머리에
 * 대상 저장소를 보이고, 해시를 누르면 그래프 대신 로그에서 그 커밋을 골라 상세를 보인다
 */
export function BlameDialog() {
  const s = useSession((st) => ({
    blame: st.blame,
    close: st.closeBlame,
    open: st.openBlame,
    jump: st.jumpToCommit,
    ignoreWhitespace: st.diffOptions.ignoreWhitespace,
    setOptions: st.setDiffOptions,
  }));
  const folder = useFolderDialogTarget();
  const ref = useModal(s.blame !== null);
  const b = s.blame;
  if (!b) {
    return null;
  }

  /** 그래프의 그 commit 으로 (폴더 탭은 로그 선택과 상세) */
  const goto = (oid: string) => {
    s.close();
    if (folder) {
      folder.showCommit(oid);
      return;
    }
    void s.jump(oid);
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={s.close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{S.history.blameTitle(b.path)}</span>
          {folder ? (
            <span className={styles.muted}>{S.history.inRepo(folder.repoName)}</span>
          ) : null}
          <span className={`${styles.muted} ${styles.mono}`}>
            {b.rev ? S.history.atRev(shortHash(b.rev)) : S.history.workTree}
          </span>
          <span className={styles.spacer} />
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={s.ignoreWhitespace}
              onChange={(e) => s.setOptions({ ignoreWhitespace: e.target.checked })}
            />
            {S.diff.ignoreWhitespace}
          </label>
          <Button onClick={s.close}>{S.history.close}</Button>
        </header>
        <ActionErrorBar />
        {b.error ? <div className={styles.error}>{b.error}</div> : null}
        {b.loading ? (
          <div className={styles.empty}>{S.history.loading}</div>
        ) : b.lines.length === 0 ? (
          <div className={styles.empty}>{S.history.empty}</div>
        ) : (
          <div className={styles.blame}>
            {b.lines.map((l, i) => {
              const first = i === 0 || b.lines[i - 1]?.oid !== l.oid;
              const prevOid = l.previousOid ?? null;
              const prevPath = l.previousPath ?? null;
              return (
                <div key={l.line} className={styles.blameRow} data-first={first ? 'true' : 'false'}>
                  <span className={styles.blameMeta}>
                    {first ? (
                      <>
                        <button
                          type="button"
                          className={styles.link}
                          title={`${l.oid}\n${l.summary}`}
                          onClick={() => goto(l.oid)}
                        >
                          {shortHash(l.oid)}
                        </button>
                        <span className={styles.blameAuthor} title={l.authorMail}>
                          {l.author}
                        </span>
                        <span className={styles.muted}>{formatDateTime(l.authorTime ?? 0)}</span>
                        {prevOid && prevPath ? (
                          <button
                            type="button"
                            className={styles.link}
                            title={S.history.previousOf(shortHash(prevOid))}
                            onClick={() => void s.open(prevPath, prevOid)}
                          >
                            ←
                          </button>
                        ) : null}
                        {l.boundary ? (
                          <span className={styles.muted}>{S.history.boundary}</span>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                  <span className={styles.lineNo}>{l.line}</span>
                  <span className={styles.lineText}>{l.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </dialog>
  );
}
