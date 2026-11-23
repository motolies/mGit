import { Button, S } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import h from '../history/history.module.css';
import styles from './preview.module.css';

/** 병합 미리보기 (CF-01·04): merge-tree 로 계산한 충돌 파일·마커 포함 결과·옵션별 비교 */
export function MergePreviewDialog() {
  const s = useSession((st) => ({
    p: st.preview,
    close: st.closeMergePreview,
    setWip: st.previewSetWip,
    simulate: st.previewSimulate,
    openFile: st.previewOpenFile,
    run: st.previewRun,
  }));
  const ref = useModal(s.p !== null);
  const p = s.p;
  if (!p) {
    return null;
  }
  const t = S.preview;
  const r = p.result;
  return (
    <dialog ref={ref} className={h.dialog} onClose={s.close}>
      <div className={h.box}>
        <header className={h.header}>
          <span className={h.title}>{t.title}</span>
          <span className={`${h.muted} ${h.mono}`}>{t.heading(p.reference)}</span>
          <span className={h.spacer} />
          <label className={styles.wip}>
            <input
              type="checkbox"
              checked={p.includeWip}
              onChange={(e) => void s.setWip(e.target.checked)}
            />
            {t.wip}
          </label>
          <Button onClick={() => void s.simulate()} disabled={p.loading || p.simulating}>
            {t.simulate}
          </Button>
          <Button onClick={() => void s.run([], 'default')} disabled={p.loading}>
            {t.run}
          </Button>
          <Button onClick={s.close}>{t.close}</Button>
        </header>
        <ActionErrorBar />
        {p.error ? <div className={h.error}>{p.error}</div> : null}
        {p.loading || !r ? (
          <div className={h.empty}>{t.loading}</div>
        ) : (
          <>
            <div className={r.clean ? styles.clean : styles.bad}>
              {r.clean ? t.clean : t.conflicts(r.conflicts.length)}
              {r.wipIncluded ? ` · ${t.wipIncluded}` : ''}
            </div>
            {p.simulating ? <div className={styles.note}>{t.simulating}</div> : null}
            {p.simulate ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t.strategy}</th>
                    <th>{t.conflictCount}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {p.simulate.map((sim) => (
                    <tr key={sim.strategy.join(',') || 'default'}>
                      <td className={h.mono}>
                        {sim.strategy.length > 0
                          ? sim.strategy.map((x) => `-X${x}`).join(' ')
                          : t.strategyNone}
                      </td>
                      <td>{sim.clean ? t.stepClean : sim.conflicts.length}</td>
                      <td>
                        <Button onClick={() => void s.run(sim.strategy, 'default')}>
                          {t.runWith}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <div className={h.split}>
              <ul className={h.files}>
                {r.conflicts.map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      className={h.file}
                      data-open={p.file?.path === f ? 'true' : 'false'}
                      title={f}
                      onClick={() => void s.openFile(f)}
                    >
                      <span className={h.path}>{f}</span>
                    </button>
                  </li>
                ))}
                {r.messages.map((m) => (
                  <li key={m} className={styles.note}>
                    {m}
                  </li>
                ))}
              </ul>
              <div className={h.diffArea}>
                {p.file ? (
                  <pre className={styles.content}>{p.file.content}</pre>
                ) : (
                  <div className={h.empty}>{r.clean ? t.cleanHint : t.pickFile}</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
