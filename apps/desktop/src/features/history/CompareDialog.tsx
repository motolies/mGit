import { Button, S } from '@mgit/ui';
import { ActionErrorBar } from '../../components/ActionErrorBar';
import { useModal } from '../../components/use-modal';
import { useSession } from '../../store';
import { changeLetter } from '../detail/change-letter';
import { DiffPaneView } from '../diff/DiffPaneView';
import styles from './history.module.css';

/** 두 ref 비교 (DIFF-06): 변경 파일 목록 + 고른 파일의 diff */
export function CompareDialog() {
  const s = useSession((st) => ({
    c: st.compare,
    close: st.closeCompare,
    select: st.compareSelectFile,
    openDifftool: st.openDifftool,
    mode: st.diffMode,
    setMode: st.setDiffMode,
    options: st.diffOptions,
    setOptions: st.setDiffOptions,
  }));
  const ref = useModal(s.c !== null);
  const c = s.c;
  if (!c) {
    return null;
  }
  const path = c.path;
  return (
    <dialog ref={ref} className={styles.dialog} onClose={s.close}>
      <div className={styles.box}>
        <header className={styles.header}>
          <span className={styles.title}>{S.history.compareTitle}</span>
          <span className={`${styles.muted} ${styles.mono}`}>
            {S.diff.compareLabel(c.a, c.b, c.threeDot)}
          </span>
          <span className={styles.spacer} />
          {path ? (
            <Button
              onClick={() =>
                void s.openDifftool({
                  kind: 'range',
                  a: c.a,
                  b: c.b,
                  threeDot: c.threeDot,
                  path,
                })
              }
            >
              {S.history.difftool}
            </Button>
          ) : null}
          <Button onClick={s.close}>{S.history.close}</Button>
        </header>
        <ActionErrorBar />
        {c.loading ? (
          <div className={styles.empty}>{S.history.loading}</div>
        ) : (
          <div className={styles.split}>
            <ul className={styles.files}>
              {c.files.length === 0 ? (
                <li className={styles.empty}>{S.history.noDiff}</li>
              ) : (
                c.files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={styles.file}
                      data-open={path === f.path ? 'true' : 'false'}
                      title={f.path}
                      onClick={() => void s.select(f.path)}
                    >
                      <span className={styles.letter}>{changeLetter(f.change.kind)}</span>
                      <span className={styles.path}>{f.path}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className={styles.diffArea}>
              {path ? (
                <DiffPaneView
                  diff={c.diff}
                  document={c.diffDocument}
                  areaLabel={S.diff.compareLabel(c.a, c.b, c.threeDot)}
                  error={null}
                  options={s.options}
                  onOptionsChange={s.setOptions}
                  onLoadFull={() => void s.select(path, true)}
                  path={path}
                  mode={s.mode}
                  onModeChange={s.setMode}
                  loading={c.diffLoading}
                />
              ) : (
                <div className={styles.empty}>{S.history.pickFile}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
