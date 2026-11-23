import { Button, S } from '@mgit/ui';
import { useSession } from '../../store';
import styles from './CommitGraphBanner.module.css';

/** commit-graph 생성 제안 배너 (AD-03) */
export function CommitGraphBanner() {
  const s = useSession((st) => ({
    suggested: st.commitGraphSuggested,
    busy: st.busy,
    write: st.commitGraphWrite,
    dismiss: st.dismissCommitGraph,
  }));
  if (!s.suggested) {
    return null;
  }
  return (
    <div className={styles.suggest}>
      <span>{S.commitGraph.suggest}</span>
      <span className={styles.actions}>
        <Button variant="primary" disabled={s.busy} onClick={() => void s.write()}>
          {s.busy ? S.commitGraph.writing : S.commitGraph.write}
        </Button>
        <Button onClick={s.dismiss}>{S.commitGraph.dismiss}</Button>
      </span>
    </div>
  );
}
