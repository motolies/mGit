import type { DiffDocument, DifftoolTarget } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { useEffect, useState } from 'react';
import {
  describeError,
  getSessionStore,
  useActiveTab,
  useAppStore,
  useFolder,
  useWorkspace,
} from '../../store';
import type { CommitDiffTarget, RangeDiffTarget } from '../../store/workspace-store';
import { useRepoSessionActions } from '../workspace/repo-session-actions';
import { useCurrentFile } from '../workspace/use-current-file';
import { DiffPaneView } from './DiffPaneView';

interface LoadedDiff {
  document: DiffDocument | null;
  loading: boolean;
  error: string | null;
}
const LOADING: LoadedDiff = { document: null, loading: true, error: null };

/** 커밋·범위 문서가 저장한 비교 대상을 읽으며 세션의 단일 diff 슬롯을 바꾸지 않는다. */
export function HistoricalDiffDoc({ doc }: { doc: CommitDiffTarget | RangeDiffTarget }) {
  const editCurrent = useCurrentFile();
  const folderRead = useFolder((state) => state.readCommitFileDiff);
  const tab = useActiveTab();
  const repoSession = tab?.kind === 'repo' ? tab.id : null;
  const client = useAppStore((state) => state.client);
  const repoActions = useRepoSessionActions();
  const ws = useWorkspace((state) => ({
    mode: state.diffMode,
    options: state.diffOptions,
    setMode: state.setDiffMode,
    setOptions: state.setDiffOptions,
  }));
  const [loaded, setLoaded] = useState<LoadedDiff>(LOADING);
  const [fullTarget, setFullTarget] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ignoreWhitespace = ws?.options.ignoreWhitespace ?? false;
  const context = ws?.options.context ?? 3;
  const { repoPath, path } = doc;
  const oid = doc.kind === 'commitDiff' ? doc.oid : null;
  const oldPath = doc.kind === 'commitDiff' ? doc.oldPath : null;
  const base = doc.kind === 'rangeDiff' ? doc.base : null;
  const newer = doc.kind === 'rangeDiff' ? doc.newer : null;
  const targetKey = JSON.stringify([repoPath, path, oid, oldPath, base, newer]);
  const full = fullTarget === targetKey;

  // 비교 범위·옵션 변경 뒤 도착한 과거 요청은 폐기한다. 고정 여부만 바뀌면 다시 읽지 않는다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt는 같은 요청을 다시 보내는 신호다.
  useEffect(() => {
    const options = { ignoreWhitespace, context };
    const request =
      base !== null && newer !== null && repoSession !== null
        ? client.compareFileDiffDocument(repoSession, base, newer, false, path, options, full)
        : oid !== null
          ? repoSession !== null
            ? client.commitFileDiffDocument(repoSession, oid, path, oldPath, full, options)
            : folderRead?.(repoPath, oid, path, oldPath, full, options)
          : undefined;
    if (!request) return;
    let live = true;
    setLoaded(LOADING);
    request.then(
      (document) => {
        if (live) setLoaded({ document, loading: false, error: null });
      },
      (error: unknown) => {
        if (live) setLoaded({ document: null, loading: false, error: describeError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [
    client,
    folderRead,
    repoSession,
    repoPath,
    path,
    oid,
    oldPath,
    base,
    newer,
    full,
    ignoreWhitespace,
    context,
    attempt,
  ]);

  if (!ws) return null;
  const difftool: DifftoolTarget =
    doc.kind === 'rangeDiff'
      ? { kind: 'range', a: doc.base, b: doc.newer, threeDot: false, path }
      : { kind: 'commit', oid: doc.oid, path };
  return (
    <DiffPaneView
      path={path}
      areaLabel={`${doc.kind === 'rangeDiff' ? doc.label : S.diff.commitLabel(shortHash(doc.oid))} · ${doc.repoName}`}
      note={doc.kind === 'commitDiff' && doc.merge ? S.diff.mergeFirstParent : undefined}
      diff={loaded.document?.diff ?? null}
      document={loaded.document}
      loading={loaded.loading}
      error={loaded.error}
      onRetry={() => setAttempt((value) => value + 1)}
      mode={ws.mode}
      onModeChange={ws.setMode}
      options={ws.options}
      onOptionsChange={ws.setOptions}
      onLoadFull={() => setFullTarget(targetKey)}
      onEditCurrent={() => editCurrent(repoPath, path, doc.repoName)}
      onDifftool={
        repoSession !== null
          ? () => {
              void getSessionStore(repoSession)?.getState().openDifftool(difftool);
            }
          : repoActions
            ? () => repoActions.difftool(repoPath, difftool)
            : undefined
      }
    />
  );
}
