import type { ChangedFile } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { useSession, useWorkspace } from '../../store';
import { diffArrival, orderedDiffFiles } from '../../store/diff-origin';
import { EMPTY_TREE } from '../../store/squash-range';
import { type OpenMode, rangeDiffDoc } from '../../store/workspace-store';
import { useCurrentFile } from '../workspace/use-current-file';
import { ChangedFilesTree } from './ChangedFilesTree';
import styles from './CommitDetail.module.css';
import { CommitDetailPane, DetailFilesMessage } from './CommitDetailPane';
import { changedFileMenu } from './changed-file-menu';
import own from './RangeDetail.module.css';

/** 선택한 커밋 범위도 변경 파일 트리와 범위 정보를 공통 분할에 표시한다. */
export function RangeDetail() {
  const editCurrent = useCurrentFile();
  const openDoc = useWorkspace((state) => state.openDoc);
  const s = useSession((st) => ({
    repoPath: st.path,
    repoName: st.name,
    range: st.range,
    clear: st.clearRange,
    openDifftool: st.openDifftool,
  }));
  const r = s.range;
  if (!r) return null;
  const count = r.to - r.from + 1;
  /** 선택 당시 비교 범위를 문서에 저장해 이후 로그 선택과 독립적으로 읽는다. */
  const open = (file: ChangedFile, mode: OpenMode) =>
    openDoc?.(
      rangeDiffDoc({
        origin: {
          kind: 'range',
          repoPath: s.repoPath,
          base: r.base,
          newer: r.newer,
          label: S.diff.rangeLabel(shortHash(r.older), shortHash(r.newer)),
          files: orderedDiffFiles(r.files),
        },
        arrival: mode === 'pinned' ? diffArrival(1) : undefined,
        repoPath: s.repoPath,
        repoName: s.repoName,
        path: file.path,
        base: r.base,
        newer: r.newer,
        label: S.diff.rangeLabel(shortHash(r.older), shortHash(r.newer)),
      }),
      mode,
    );
  return (
    <CommitDetailPane
      files={
        r.loading ? (
          <DetailFilesMessage>{S.detail.loading}</DetailFilesMessage>
        ) : r.files.length === 0 ? (
          <DetailFilesMessage>{S.detail.noFiles}</DetailFilesMessage>
        ) : (
          <ChangedFilesTree
            key={`${s.repoPath}\u0000${r.base}\u0000${r.newer}`}
            files={r.files}
            root={{ name: s.repoName }}
            onPreview={(file) => open(file, 'preview')}
            onOpen={(file) => open(file, 'pinned')}
            menu={(file) =>
              changedFileMenu(file, s.repoPath, {
                showDiff: () => open(file, 'pinned'),
                editCurrent: () => editCurrent(s.repoPath, file.path, s.repoName),
                difftool: () =>
                  void s.openDifftool({
                    kind: 'range',
                    a: r.base,
                    b: r.newer,
                    threeDot: false,
                    path: file.path,
                  }),
              })
            }
          />
        )
      }
      info={
        <>
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
        </>
      }
    />
  );
}
