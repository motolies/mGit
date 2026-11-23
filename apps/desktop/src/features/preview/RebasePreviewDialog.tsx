import { Button, S, shortHash } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import h from '../history/history.module.css';
import styles from './preview.module.css';

/** rebase 예측 (CF-03): commit 을 하나씩 얹어 본 결과. 첫 충돌 뒤는 근사치 */
export function RebasePreviewDialog() {
  const s = useSession((st) => ({
    p: st.rebasePreview,
    close: st.closeRebasePreview,
    rebase: st.rebase,
  }));
  const ref = useModal(s.p !== null);
  const p = s.p;
  if (!p) {
    return null;
  }
  const t = S.preview;
  const conflicts = p.steps.filter((x) => !x.clean).length;
  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{t.rebaseTitle}</span>
          <span className={`${h.muted} ${h.mono}`}>{t.rebaseHeading(p.onto)}</span>
          <span className={h.spacer} />
          <Button
            onClick={() => {
              s.close();
              void s.rebase(p.onto, true);
            }}
            disabled={p.loading}
          >
            {t.rebaseRun}
          </Button>
          <Button onClick={s.close}>{t.close}</Button>
        </header>
        <ActionErrorBar />
        {p.error ? <div className={h.error}>{p.error}</div> : null}
        {p.loading ? (
          <div className={h.empty}>{t.loading}</div>
        ) : p.steps.length === 0 ? (
          <div className={h.empty}>{t.rebaseEmpty}</div>
        ) : (
          <>
            <div className={conflicts === 0 ? styles.clean : styles.bad}>
              {conflicts === 0 ? t.rebaseClean : t.rebaseConflicts(conflicts, p.steps.length)}
            </div>
            <ul className={styles.steps}>
              {p.steps.map((step) => (
                <li key={step.oid} className={styles.step}>
                  <span className={h.mono}>{shortHash(step.oid)}</span>
                  <span className={h.path}>{step.subject}</span>
                  <span className={step.clean ? styles.clean : styles.bad}>
                    {step.clean ? t.stepClean : t.stepConflict(step.conflicts.join(', '))}
                    {step.approximate ? ` (${t.approximate})` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </dialog>
  );
}
