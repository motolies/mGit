import type { FsEncoding, FsLineEnding, SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { describeError, useActiveTab, useAppStore, useFileTree } from '../../store';
import { useExplicitRefresh } from '../../store/explicit-refresh';
import { type EditorOpenResult, encodingOf, fileEditors } from '../../store/file-editor-store';
import type { FileTreeStore } from '../../store/file-tree';
import {
  getFolderStore,
  getSessionStore,
  getWorkspaceStore,
  refreshEditedFile,
} from '../../store/session-registry';
import { tabSpace } from '../../store/session-space';
import { useEditorSelect } from '../../store/use-file-editors';
import type { FileViewTarget } from '../../store/workspace-store';
import { EncodingMenu, encodingName } from './EncodingMenu';
import { type ExternalOpenAction, ExternalOpenBar, externalOpenActions } from './ExternalOpenBar';
import { FileEditor } from './FileEditor';
import { FileView, type FileViewRepoTools } from './FileView';
import { type MixedLineEndingsFile, MixedLineEndingsView } from './MixedLineEndingsView';

export type { FileViewRepoTools } from './FileView';

/**
 * 저장 뒤 파일 감시가 Git 상태를 다시 읽기까지 기다리는 시간 (G1). 감시는 알림 감시가 안 되면 2초 폴링으로 바꾸므로 그 주기
 * 와 묶음·status 읽기의 여유를 더했다. 이 안에 상태가 바뀌지 않으면 감시가 죽은 것으로 보고 전체 새로고침을 한다
 */
export const WATCH_GRACE_MS = 3000;

/**
 * 감시가 살아 있으면 저장 뒤 Git 상태는 감시가 다시 읽는다 — ref 를 다시 읽는 전체 새로고침은 하지 않는다 (G1). 감시가 죽은
 * 경우의 대체 경로: 저장 전에 깨끗하던 파일(상태 목록에 없음)은 저장으로 상태가 바뀌어야 하므로, 정한 시간 안에 상태가 바뀌지
 * 않으면 그때만 전체 새로고침을 한다. 이미 바뀐 파일은 다시 저장해도 상태가 그대로일 수 있어(코어는 바뀔 때만 알린다)
 * 기다리지 않는다
 */
export function confirmSavedStatus(
  store: NonNullable<ReturnType<typeof getSessionStore>>,
  path: string,
): void {
  const before = store.getState().status;
  if (before.entries.some((entry) => entry.path === path)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = store.subscribe((now) => {
    if (now.status === before) return;
    off();
    clearTimeout(timer);
  });
  timer = setTimeout(() => {
    off();
    void store.getState().refresh();
  }, WATCH_GRACE_MS);
}

/** 그 파일이 든 디렉터리를 이미 나열해 두었으면 그 디렉터리 하나만 다시 읽는다 (크기·수정 시각, 트리 epoch 는 그대로) */
function reloadParentDir(tree: FileTreeStore, path: string): void {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  const state = tree.getState();
  if (state.dirs[dir]?.load.state === 'listed') state.retry(dir);
}

/**
 * 저장 뒤 갱신 (G1). 같은 파일을 보는 diff 화면을 다시 읽고, 파일 트리는 그 파일의 디렉터리 하나만 다시 읽으며, Git 상태는
 * 감시에 맡긴다(대체 경로는 `confirmSavedStatus`). 내용만 바뀐 저장은 목록이 바뀌지 않으므로 트리 전체를 다시 읽지 않는다 —
 * 그래서 편집기의 Blame·HEAD 원문 재조회도 일어나지 않는다. `full` 이면(줄 끝 통일) 예전처럼 상태·트리 전체를 다시 읽는다
 */
function afterSave(session: SessionId, path: string, { full = false } = {}): void {
  void refreshEditedFile(session, path);
  const repoStore = getSessionStore(session);
  const repo = repoStore?.getState();
  const folder = getFolderStore(session)?.getState();
  if (full) {
    if (repo) {
      void repo.refresh();
      void repo.reloadFiles();
    }
    if (folder) void folder.fileTree.getState().reload();
    return;
  }
  if (repoStore) confirmSavedStatus(repoStore, path);
  const tree = repo?.fileTree ?? folder?.fileTree;
  if (tree) reloadParentDir(tree, path);
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
  // 편집기의 Blame·HEAD 원문 재조회와 미리보기 그림 캐시 교체는 명시적 새로고침에만 한다. 트리 epoch(창 포커스·ref 변경 등)는
  // 이 문서를 다시 여는 신호로만 쓴다 (G1)
  const explicitRefresh = useExplicitRefresh(session);
  const [result, setResult] = useState<EditorOpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 별칭이 가리키는 문서(이동·덮어쓰기로 합쳐지면 바뀐다)와 고른 인코딩이 바뀔 때만 다시 그린다. 문서 안의 변화는 편집기가
  // 그 문서만 구독해 받는다 (F1)
  const aliased = useEditorSelect(() =>
    session === undefined ? undefined : fileEditors.get(session, doc.path),
  );
  const chosen = useEditorSelect(
    () => session !== undefined && fileEditors.encodingChoice(session, doc.path) !== null,
  );
  // 이동(remap)은 같은 문서 객체의 디스크 식별자를 바꾼다 — 그때 편집기를 새로 붙이도록(key) 식별자도 본다
  useEditorSelect(() =>
    session === undefined ? undefined : fileEditors.get(session, doc.path)?.fileKey,
  );

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
        // 줄 끝 통일은 다시 읽어 편집기로 여는 큰 바꿈이라 예전처럼 상태·트리 전체를 다시 읽는다
        afterSave(session, doc.path, { full: true });
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
  /** 편집기로 열지 못한 텍스트 파일의 머리줄 인코딩 단추 */
  const encodingMenu = (encoding: FsEncoding | null, guessed: boolean) => (
    <EncodingMenu encoding={encoding} guessed={guessed} chosen={chosen} onChoose={chooseEncoding} />
  );

  // 이동·덮어쓰기에서 공유 별칭이 합쳐지면 이미 열린 대상 탭도 최신 문서를 사용한다.
  const current = session === undefined ? result : (aliased ?? result);
  if (current && 'fileKey' in current)
    return session === undefined ? null : (
      <FileEditor
        key={current.fileKey}
        doc={current}
        repoTools={repoTools}
        repoPath={doc.repoPath}
        source={{ client, session, path: doc.path }}
        refreshEpoch={explicitRefresh}
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
