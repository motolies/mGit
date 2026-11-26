import type { FsEncoding, FsLineEnding, SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { describeError, useActiveTab, useAppStore, useFileTree } from '../../store';
import { type EditorOpenResult, encodingOf, fileEditors } from '../../store/file-editor-store';
import {
  getFolderStore,
  getSessionStore,
  getWorkspaceStore,
  refreshEditedFile,
} from '../../store/session-registry';
import { tabSpace } from '../../store/session-space';
import type { FileViewTarget } from '../../store/workspace-store';
import { EncodingMenu, encodingName } from './EncodingMenu';
import { type ExternalOpenAction, ExternalOpenBar, externalOpenActions } from './ExternalOpenBar';
import { FileEditor } from './FileEditor';
import { FileView, type FileViewRepoTools } from './FileView';
import { type MixedLineEndingsFile, MixedLineEndingsView } from './MixedLineEndingsView';

export type { FileViewRepoTools } from './FileView';

/** 저장 뒤 같은 파일을 보는 화면과 저장소·폴더의 상태·파일 트리를 다시 읽는다 (편집 저장·줄 끝 통일 공용) */
function afterSave(session: SessionId, path: string): void {
  void refreshEditedFile(session, path);
  const repo = getSessionStore(session)?.getState();
  if (repo) {
    void repo.refresh();
    void repo.reloadFiles();
  }
  const folder = getFolderStore(session)?.getState();
  if (folder) void folder.fileTree.getState().reload();
}

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
  const key = useAppStore((s) =>
    session === undefined ? null : (s.sessions[session]?.path ?? null),
  );
  const openExternal = useAppStore((s) => s.openExternal);
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
        onSaved: () => afterSave(session, doc.path),
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

  /**
   * 줄 끝 통일 저장 (확인은 화면이 받았다). 성공하면 수정처럼 탭을 고정하고 저장 뒤 갱신을 돌린 다음 다시 읽어 편집기로
   * 연다. 그사이 파일이 바뀌었으면 바뀐 원문을 다시 읽는다. 통일하지 못한 사유를 돌려준다 (성공이면 null). UTF-8 이 아닌
   * 파일은 같은 인코딩으로 읽고 쓴다 (R2)
   */
  const normalize = async (
    file: MixedLineEndingsFile,
    target: FsLineEnding,
  ): Promise<string | null> => {
    if (session === undefined) return null;
    const t = S.fileEditor;
    const encoding = encodingOf(file);
    try {
      const saved =
        encoding === 'utf8'
          ? await client.fsNormalizeLineEndings(session, doc.path, file.revision, target)
          : await client.fsNormalizeLineEndings(session, doc.path, file.revision, target, encoding);
      if (saved.kind === 'saved') {
        getWorkspaceStore(session)?.getState().pinDoc(doc.id);
        afterSave(session, doc.path);
      }
      if (saved.kind !== 'failed') setAttempt((value) => value + 1);
      if (saved.kind === 'saved') return null;
      return saved.kind === 'conflict' ? t.normalizeConflict : t.normalizeFailed(saved.message);
    } catch (cause) {
      return t.normalizeFailed(describeError(cause));
    }
  };

  /**
   * 머리줄 인코딩 단추에서 고른 인코딩으로 다시 연다 (R2, null 이면 자동). 저장하지 않은 편집이 있으면 바꾸지 않는다
   * (단추가 막혀 있다). 지금 결과를 비우고 다시 읽는다
   */
  const chooseEncoding = (encoding: FsEncoding | null) => {
    if (session === undefined || !fileEditors.chooseEncoding(session, doc.path, encoding)) return;
    setResult(null);
    setAttempt((value) => value + 1);
  };
  const chosen = session !== undefined && fileEditors.encodingChoice(session, doc.path) !== null;
  /** 편집기로 열지 못한 텍스트 파일의 머리줄 인코딩 단추 */
  const encodingMenu = (encoding: FsEncoding | null, guessed: boolean) => (
    <EncodingMenu encoding={encoding} guessed={guessed} chosen={chosen} onChoose={chooseEncoding} />
  );

  // 이동·덮어쓰기에서 공유 별칭이 합쳐지면 이미 열린 대상 탭도 최신 문서를 사용한다.
  const current = session === undefined ? result : (fileEditors.get(session, doc.path) ?? result);
  if (current && 'fileKey' in current)
    return session === undefined ? null : (
      <FileEditor
        key={current.fileKey}
        doc={current}
        repoTools={repoTools}
        repoPath={doc.repoPath}
        source={{ client, session, path: doc.path }}
        refreshEpoch={epoch}
        onEncoding={chooseEncoding}
      />
    );
  if (current?.kind === 'mixedLineEndings') {
    return (
      <MixedLineEndingsView
        path={doc.path}
        file={current}
        repoTools={repoTools}
        encoding={encodingMenu(encodingOf(current), current.guessed === true)}
        onNormalize={(target) => normalize(current, target)}
      />
    );
  }
  // 내용을 보이지 못하는 파일은 안내 위 띠에서 외부 편집기·Finder 로 연다. 폴더 탭·저장소 탭 모두 탭의 경로 공간으로
  // 문서 경로의 절대 경로를 만든다 (저장소가 정해져 있지 않아도 된다)
  // (여기까지 왔으면 텍스트·줄 끝이 섞인 파일은 이미 위에서 그렸다)
  const absolute =
    session === undefined || key === null
      ? null
      : (tabSpace(session, key)?.toAbs(doc.path) ?? null);
  /** 띠의 외부 앱 단추를 누르면 그 앱으로 연다 */
  const onOpen = (action: ExternalOpenAction) => {
    if (absolute !== null) void openExternal(action, absolute);
  };
  // 같은 인코딩으로 다시 쓸 수 없는 파일 (R2): 디코드한 원문을 읽기 전용으로 보이고 까닭과 외부 앱 단추를 띠에 둔다
  if (current?.kind === 'lossy') {
    const name = encodingName(current.encoding);
    return (
      <FileView
        path={doc.path}
        repoTools={repoTools}
        encoding={encodingMenu(current.encoding, current.guessed)}
        banner={
          error ? null : (
            <ExternalOpenBar
              message={
                current.malformed
                  ? S.fileEditor.lossyMalformed(name)
                  : S.fileEditor.lossyIrreversible(name)
              }
              actions={absolute !== null ? ['editor', 'reveal'] : []}
              onOpen={onOpen}
            />
          )
        }
        load={
          error
            ? { state: 'error', error }
            : { state: 'loaded', file: { kind: 'text', text: current.text, size: current.size } }
        }
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  const unavailable = !error && current ? current : null;
  // 어느 인코딩으로도 읽지 못한 파일은 인코딩을 골라 열 수 있다. 고른 인코딩이 바이너리로 끝났으면 되돌릴 수 있게 둔다
  const pickable = unavailable?.kind === 'notUtf8' || (unavailable?.kind === 'binary' && chosen);
  const banner =
    unavailable && absolute !== null ? (
      <ExternalOpenBar
        message={unavailable.kind === 'notUtf8' ? S.fileEditor.notUtf8Hint : undefined}
        actions={externalOpenActions(unavailable.kind)}
        onOpen={onOpen}
      />
    ) : null;
  return (
    <FileView
      path={doc.path}
      repoTools={repoTools}
      banner={banner}
      encoding={pickable ? encodingMenu(null, false) : null}
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
