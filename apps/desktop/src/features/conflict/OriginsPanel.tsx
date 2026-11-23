import type { ConflictOrigins, OriginCommit, SideLabels } from '@mgit/ipc';
import { formatDateTime, S, shortHash } from '@mgit/ui';
import styles from './assist.module.css';

/** 충돌 출처 패널 (CF-17): 이 파일을 건드린 양쪽 commit. 클릭하면 그래프에서 찾는다 */
export function OriginsPanel({
  origins,
  labels,
  loading,
  onJump,
}: {
  origins: ConflictOrigins | null;
  labels: SideLabels;
  loading: boolean;
  onJump: (oid: string) => void;
}) {
  const t = S.assist;
  const row = (c: OriginCommit, extra?: string) => (
    <button
      key={c.oid}
      type="button"
      className={styles.originRow}
      onClick={() => onJump(c.oid)}
      title={`${c.author} · ${formatDateTime(c.time ?? 0)}`}
    >
      <span className={styles.mono}>{shortHash(c.oid)}</span>
      <span className={styles.subject}>{c.subject}</span>
      {extra ? <span className={styles.badge}>{extra}</span> : null}
    </button>
  );
  const side = (title: string, list: OriginCommit[], current?: OriginCommit | null) => (
    <div>
      <div className={styles.originsTitle}>{title}</div>
      {current ? row(current, t.originsCurrent) : null}
      {list.filter((c) => c.oid !== current?.oid).map((c) => row(c))}
      {list.length === 0 && !current ? <div className={styles.note}>{t.originsEmpty}</div> : null}
    </div>
  );
  if (loading || !origins) {
    return <div className={styles.origins}>{S.history.loading}</div>;
  }
  return (
    <div className={styles.origins}>
      {side(labels.ours, origins.ours)}
      {side(labels.theirs, origins.theirs, origins.current)}
    </div>
  );
}
