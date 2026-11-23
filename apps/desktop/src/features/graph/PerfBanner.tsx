import { Button, S } from '@mgit/ui';
import { useSession } from '../../store';
import styles from './PerfBanner.module.css';

/** 추적 파일이 많은 저장소에 fsmonitor 를 제안하는 배너 (AD-07) */
export function PerfBanner() {
  const s = useSession((st) => ({
    perf: st.perfSuggestion,
    enable: st.enablePerf,
    dismiss: st.dismissPerf,
    busy: st.busy,
  }));
  if (!s.perf?.suggested) {
    return null;
  }
  return (
    <div className={styles.banner}>
      <span className={styles.text}>{S.graph.perf.title(s.perf.trackedFiles)}</span>
      <Button variant="primary" disabled={s.busy} onClick={() => void s.enable()}>
        {S.graph.perf.enable}
      </Button>
      <Button onClick={s.dismiss}>{S.graph.perf.dismiss}</Button>
    </div>
  );
}
