import type { FileDiff } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { describeError, useFolder, useWorkspace } from '../../store';
import type { CommitDiffTarget } from '../../store/workspace-store';
import { DiffPaneView } from '../diff/DiffPaneView';
import { useRepoSessionActions } from '../workspace/repo-session-actions';

/** 읽은 diff 와 그 상태 */
interface LoadedDiff {
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
}

const LOADING: LoadedDiff = { diff: null, loading: true, error: null };

/**
 * 에디터 공간의 커밋 파일 diff 탭 (폴더, ED-03·CD-04): 읽기 전용이라 stage·되돌리기·"← 그래프로" 가 없고
 * 탭 닫기로 돌아간다. 폴더 API 로 읽으므로 diff 를 보는 것만으로는 저장소 세션을 만들지 않는다 (CD-05). "외부 도구"를
 * 누를 때만 그 저장소의 세션을 연다 (W13). 보이는 탭만 마운트되므로 보이는 탭만 읽고, 보기 옵션·"전체 보기" 가
 * 바뀌면 다시 읽는다. 늦게 온 옛 응답은 버린다
 */
export function FolderCommitDiff({ doc }: { doc: CommitDiffTarget }) {
  const read = useFolder((st) => st.readCommitFileDiff);
  const repoActions = useRepoSessionActions();
  const ws = useWorkspace((w) => ({
    mode: w.diffMode,
    options: w.diffOptions,
    setMode: w.setDiffMode,
    setOptions: w.setDiffOptions,
  }));
  const [loaded, setLoaded] = useState<LoadedDiff>(LOADING);
  const [full, setFull] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ignoreWhitespace = ws?.options.ignoreWhitespace ?? false;
  const context = ws?.options.context ?? 3;
  const { repoPath, oid, path, oldPath } = doc;

  // 대상·옵션·"전체 보기"·다시 시도가 바뀔 때마다 읽는다. 정리 함수가 그 뒤에 온 옛 응답을 버린다
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 는 "다시 시도" 로 같은 요청을 다시 보내는 신호다
  useEffect(() => {
    if (!read) {
      return;
    }
    let live = true;
    setLoaded((prev) => ({ ...prev, loading: true, error: null }));
    read(repoPath, oid, path, oldPath, full, { ignoreWhitespace, context }).then(
      (diff) => {
        if (live) {
          setLoaded({ diff, loading: false, error: null });
        }
      },
      (e: unknown) => {
        if (live) {
          setLoaded({ diff: null, loading: false, error: describeError(e) });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [read, repoPath, oid, path, oldPath, full, ignoreWhitespace, context, attempt]);

  if (!ws) {
    return null;
  }
  return (
    <DiffPaneView
      path={path}
      areaLabel={`${S.diff.commitLabel(shortHash(oid))} · ${doc.repoName}`}
      note={doc.merge ? S.diff.mergeFirstParent : undefined}
      diff={loaded.diff}
      loading={loaded.loading}
      error={loaded.error}
      onRetry={() => setAttempt((n) => n + 1)}
      mode={ws.mode}
      onModeChange={ws.setMode}
      options={ws.options}
      onOptionsChange={ws.setOptions}
      onLoadFull={() => setFull(true)}
      onDifftool={
        repoActions
          ? () => repoActions.difftool(repoPath, { kind: 'commit', oid, path })
          : undefined
      }
    />
  );
}
