import { S } from '@mgit/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { describeError, useActiveTab, useAppStore, useFileTree } from '../../store';
import { type EditorOpenResult, fileEditors } from '../../store/file-editor-store';
import {
  getFolderStore,
  getSessionStore,
  getWorkspaceStore,
  refreshEditedFile,
} from '../../store/session-registry';
import type { FileViewTarget } from '../../store/workspace-store';
import { FileEditor } from './FileEditor';
import { FileView, type FileViewRepoTools } from './FileView';

export type { FileViewRepoTools } from './FileView';

/** 일반 파일을 공유 문서로 열고 첫 수정 시 고정한다. 저장 결과는 기존 파일·Git 갱신 경로로 전달한다. */
export function FileViewDoc({
  doc,
  repoTools = null,
}: {
  doc: FileViewTarget & { id: string };
  repoTools?: FileViewRepoTools | null;
}) {
  const tab = useActiveTab();
  const session = tab?.id;
  const client = useAppStore((s) => s.client);
  const epoch = useFileTree((tree) => tree.epoch) ?? 0;
  const [result, setResult] = useState<EditorOpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useSyncExternalStore(fileEditors.subscribe, fileEditors.getVersion);

  // 화면을 벗어나도 타이머와 문서는 저장소에 남는다. 닫기 처리가 끝난 뒤에만 별칭을 해제한다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt와 epoch는 요청 실패와 디스크 변경 뒤 재조회 신호다.
  useEffect(() => {
    if (session === undefined) return;
    let live = true;
    setError(null);
    void fileEditors
      .open(client, session, doc.path, {
        onDirty: () => getWorkspaceStore(session)?.getState().pinDoc(doc.id),
        onSaved: () => {
          void refreshEditedFile(session, doc.path);
          const repo = getSessionStore(session)?.getState();
          if (repo) {
            void repo.refresh();
            void repo.reloadFiles();
          }
          const folder = getFolderStore(session)?.getState();
          if (folder) void folder.fileTree.getState().reload();
        },
      })
      .then(
        (file) => {
          if (live) setResult(file);
        },
        (cause: unknown) => {
          if (live) setError(describeError(cause));
        },
      );
    return () => {
      live = false;
    };
  }, [client, session, doc.id, doc.path, attempt, epoch]);

  // 이동·덮어쓰기에서 공유 별칭이 합쳐지면 이미 열린 대상 탭도 최신 문서를 사용한다.
  const current = session === undefined ? result : (fileEditors.get(session, doc.path) ?? result);
  if (current && 'fileKey' in current)
    return session === undefined ? null : (
      <FileEditor
        key={current.fileKey}
        doc={current}
        repoTools={repoTools}
        source={{ client, session, path: doc.path }}
        refreshEpoch={epoch}
      />
    );
  if (current?.kind === 'mixedLineEndings') {
    return <div role="status">{S.fileEditor.mixedLineEndings}</div>;
  }
  return (
    <FileView
      path={doc.path}
      repoTools={repoTools}
      load={
        error
          ? { state: 'error', error }
          : current
            ? { state: 'loaded', file: current }
            : { state: 'loading' }
      }
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
