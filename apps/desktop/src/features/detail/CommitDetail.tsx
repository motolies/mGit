import type { ChangedFile } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useEffect } from 'react';
import { useSession, useWorkspace } from '../../store';
import { diffArrival, orderedDiffFiles } from '../../store/diff-origin';
import { commitDiffDoc, type OpenMode } from '../../store/workspace-store';
import { useCurrentFile } from '../workspace/use-current-file';
import { ChangedFilesTree } from './ChangedFilesTree';
import { CommitDetailPane, DetailFilesMessage } from './CommitDetailPane';
import { CommitDetailView } from './CommitDetailView';
import { changedFileMenu } from './changed-file-menu';

/** 저장소 상세도 멀티 저장소와 같은 변경 파일 트리/커밋 정보 분할을 사용한다. */
export function CommitDetail() {
  const editCurrent = useCurrentFile();
  const openDoc = useWorkspace((state) => state.openDoc);
  const s = useSession((st) => ({
    oid: st.selectedCommit,
    repoPath: st.path,
    repoName: st.name,
    openBlame: st.openBlame,
    openFileHistory: st.openFileHistory,
    openDifftool: st.openDifftool,
    detail: st.detail,
    loading: st.detailLoading,
    headOid: st.refs.head.state === 'unborn' ? null : st.refs.head.oid,
    jumpToCommit: st.jumpToCommit,
    signature: st.detailSignature,
    containing: st.containing,
    showContaining: st.showContaining,
    retryContaining: st.retryContaining,
  }));
  // 포함 branch (CD-03): 상세가 뜬 커밋만 스토어에 알린다 (스토어가 디바운스 뒤에 읽는다)
  const showContaining = s.showContaining;
  const shownOid = s.detail?.oid ?? null;
  useEffect(() => {
    showContaining(shownOid);
  }, [showContaining, shownOid]);
  // 패널이 내려가면 예약한 읽기를 거둔다
  useEffect(() => () => showContaining(null), [showContaining]);
  if (!s.oid) {
    return null;
  }
  const d = s.detail?.oid === s.oid ? s.detail : null;
  const oid = s.oid;
  /** 파일별 독립 문서를 열어 단일 클릭 미리보기와 고정 탭을 멀티 저장소와 맞춘다. */
  const open = (file: ChangedFile, mode: OpenMode) => {
    if (!d) return;
    openDoc?.(
      commitDiffDoc({
        origin: {
          kind: 'commit',
          repoPath: s.repoPath,
          oid: d.oid,
          files: orderedDiffFiles(d.files),
        },
        arrival: mode === 'pinned' ? diffArrival(1) : undefined,
        repoPath: s.repoPath,
        repoName: s.repoName,
        oid: d.oid,
        path: file.path,
        oldPath: file.oldPath ?? null,
        merge: d.parents.length > 1,
      }),
      mode,
    );
  };
  return (
    <CommitDetailPane
      files={
        !d ? (
          <DetailFilesMessage>{s.loading ? S.detail.loading : ''}</DetailFilesMessage>
        ) : d.files.length === 0 ? (
          <DetailFilesMessage>{S.detail.noFiles}</DetailFilesMessage>
        ) : (
          <ChangedFilesTree
            key={`${s.repoPath}\u0000${d.oid}`}
            files={d.files}
            root={{ name: s.repoName }}
            onPreview={(file) => open(file, 'preview')}
            onOpen={(file) => open(file, 'pinned')}
            menu={(file) =>
              changedFileMenu(file, s.repoPath, {
                showDiff: () => open(file, 'pinned'),
                editCurrent: () => editCurrent(s.repoPath, file.path, s.repoName),
                blame: () => void s.openBlame(file.path, d.oid),
                history: () => void s.openFileHistory(file.path),
                difftool: () =>
                  void s.openDifftool({ kind: 'commit', oid: d.oid, path: file.path }),
              })
            }
          />
        )
      }
      info={
        d ? (
          <CommitDetailView
            detail={d}
            isHead={s.headOid === d.oid}
            onCopyHash={() => navigator.clipboard.writeText(oid)}
            onNavigate={(target) => void s.jumpToCommit(target)}
            signature={s.signature}
            containing={{
              load: s.containing?.of === d.oid ? s.containing : { state: 'loading' },
              onRetry: s.retryContaining,
            }}
          />
        ) : null
      }
    />
  );
}
