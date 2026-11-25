import { S, shortHash } from '@mgit/ui';
import { ContextMenuArea } from '../../components/ContextMenu';
import { useSession } from '../../store';
import { EMPTY_TREE } from '../../store/squash-range';
import { useCurrentFile } from '../workspace/use-current-file';
import styles from './CommitDetail.module.css';
import { changeLetter } from './change-letter';
import own from './RangeDetail.module.css';

/** 우측 패널: ⇧+클릭으로 고른 commit 범위의 결합 diff 파일 목록 (GRAPH-10) */
export function RangeDetail() {
  const editCurrent = useCurrentFile();
  const s = useSession((st) => ({
    repoPath: st.path,
    repoName: st.name,
    range: st.range,
    clear: st.clearRange,
    openRangeFile: st.openRangeFile,
    openDifftool: st.openDifftool,
    openPath: st.selectedFile?.range ? st.selectedFile.path : null,
  }));
  const r = s.range;
  if (!r) {
    return null;
  }
  const count = r.to - r.from + 1;
  return (
    <aside className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.title}>{S.detail.rangeTitle(count)}</span>
        <span className={own.range} title={`${r.older}..${r.newer}`}>
          {shortHash(r.older)}..{shortHash(r.newer)}
        </span>
        <button type="button" className={styles.link} onClick={s.clear}>
          {S.detail.rangeClear}
        </button>
      </header>
      <div className={own.hint}>
        {S.detail.rangeHint}
        {!r.loading && r.base === EMPTY_TREE ? ` ${S.detail.rangeRoot}` : ''}
      </div>
      {r.loading ? (
        <div className={styles.loading}>{S.detail.loading}</div>
      ) : (
        <div className={styles.body}>
          <div className={styles.filesHeader}>{S.detail.files(r.files.length)}</div>
          {r.files.length === 0 ? (
            <div className={styles.loading}>{S.detail.noFiles}</div>
          ) : (
            <ContextMenuArea<string>
              resolveTarget={(e) =>
                (e.target as HTMLElement | null)
                  ?.closest('[data-path]')
                  ?.getAttribute('data-path') ?? null
              }
              items={(path) => [
                {
                  label: S.fileView.editCurrent,
                  onSelect: () => editCurrent(s.repoPath, path, s.repoName),
                },
                {
                  label: S.menu.difftool,
                  onSelect: () =>
                    void s.openDifftool({
                      kind: 'range',
                      a: r.base,
                      b: r.newer,
                      threeDot: false,
                      path,
                    }),
                },
              ]}
            >
              <ul className={styles.files}>
                {r.files.map((f) => (
                  <li
                    key={f.path}
                    className={styles.file}
                    data-path={f.path}
                    data-open={s.openPath === f.path ? 'true' : 'false'}
                    title={f.path}
                  >
                    <button
                      type="button"
                      className={styles.fileButton}
                      onClick={() => void s.openRangeFile(f.path)}
                    >
                      <span className={styles.letter} data-letter={changeLetter(f.change.kind)}>
                        {changeLetter(f.change.kind)}
                      </span>
                      <span className={styles.path}>{f.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </ContextMenuArea>
          )}
        </div>
      )}
    </aside>
  );
}
