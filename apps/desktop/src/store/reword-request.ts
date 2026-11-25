import type { SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { create } from 'zustand';
import { useAppStore } from './app-store-instance';
import { describeError } from './errors';
import { getFolderStore, getSessionStore } from './session-registry';

/** 폴더에서 편집을 시작한 저장소·커밋·세션을 고정한다. */
export interface RewordRequest {
  folderId: SessionId;
  repoPath: string;
  sessionId: SessionId;
  oid: string;
  token: number;
}

export const useRewordRequest = create<{ request: RewordRequest | null }>(() => ({
  request: null,
}));
let pending: { key: string; cancel: () => void } | null = null;

/** 편집창 종료 시 예약과 구독을 함께 해제한다. */
export function finishRewordRequest(request: RewordRequest): void {
  if (useRewordRequest.getState().request === request) pending?.cancel();
}

/** 폴더 화면 안에서 숨은 세션을 빌린다. 전체 그래프 로드·탭 생성·커밋 선택 이동은 하지 않는다. */
export async function requestRepoReword(
  folderId: SessionId,
  repoPath: string,
  oid: string,
): Promise<void> {
  const key = `${folderId}:${repoPath}:${oid}`;
  if (pending?.key === key) return;
  const previous = useRewordRequest.getState().request;
  if (previous && getSessionStore(previous.sessionId)?.getState().rewordEditor?.phase === 'saving')
    return;
  pending?.cancel();
  const controller = new AbortController();
  let request: RewordRequest | null = null;
  let startError: string | null = null;
  const folder = getFolderStore(folderId);
  const selected = folder?.getState().timeline.selected;
  const saving = () =>
    request !== null &&
    getSessionStore(request.sessionId)?.getState().rewordEditor?.phase === 'saving';
  const cancel = () => {
    controller.abort();
    unsubscribeApp();
    unsubscribeFolder?.();
    if (request) getSessionStore(request.sessionId)?.getState().endRewordEditor(request.token);
    if (pending?.key === key) {
      pending = null;
      useRewordRequest.setState({ request: null });
    }
  };
  const unsubscribeApp = useAppStore.subscribe((state) => {
    if (!saving() && (state.activeSessionId !== folderId || !state.sessions[folderId])) cancel();
  });
  const unsubscribeFolder = folder?.subscribe((state) => {
    const loading =
      !request || getSessionStore(request.sessionId)?.getState().rewordEditor?.phase === 'loading';
    if (
      !saving() &&
      ((loading && state.timeline.selected !== selected) ||
        !state.repos.some((repo) => repo.path === repoPath))
    )
      cancel();
  });
  pending = { key, cancel };
  const ok = await useAppStore.getState().withRepoSession(folderId, repoPath, (state) => {
    if (controller.signal.aborted) return;
    const token = state.beginRewordEditor(folderId, oid);
    if (token === null) {
      startError = getSessionStore(state.id)?.getState().actionError ?? S.shortcuts.rewordBusy;
      return;
    }
    request = { folderId, repoPath, sessionId: state.id, oid, token };
    useRewordRequest.setState({ request });
  });
  const current = request as RewordRequest | null;
  if (!ok || !current || controller.signal.aborted) {
    if (!controller.signal.aborted) {
      if (ok)
        useAppStore
          .getState()
          .notice({ kind: 'info', title: startError ?? S.shortcuts.rewordBusy });
      cancel();
    }
    return;
  }
  const store = getSessionStore(current.sessionId);
  if (!store) {
    cancel();
    return;
  }
  const fail = () => {
    if (controller.signal.aborted) return;
    useAppStore
      .getState()
      .notice({ kind: 'error', title: store.getState().actionError ?? S.shortcuts.rewordFailed });
    cancel();
  };
  if (!(await store.getState().checkRewordAllowed(oid))) {
    fail();
    return;
  }
  if (controller.signal.aborted) return;
  const message = await store.getState().commitMessageOf(oid);
  if (controller.signal.aborted) return;
  if (message === null) {
    fail();
    return;
  }
  const state = store.getState();
  const editor = state.rewordEditor;
  const head = state.refs.head;
  if (!editor || editor.token !== current.token) {
    cancel();
    return;
  }
  state.patchRewordEditor(current.token, {
    phase: 'editing',
    message,
    initialMessage: message,
    error:
      head.state !== 'attached' || head.branch !== editor.headBranch || head.oid !== editor.headOid
        ? S.shortcuts.rewordChanged
        : null,
  });
}

/** 입력 초안을 그대로 저장하고 실패 시 편집창과 내용을 남긴다. */
export async function saveRewordRequest(request: RewordRequest): Promise<void> {
  if (useRewordRequest.getState().request !== request) return;
  const store = getSessionStore(request.sessionId);
  const editor = store?.getState().rewordEditor;
  if (
    !store ||
    !editor ||
    editor.token !== request.token ||
    editor.phase !== 'editing' ||
    !editor.message.trim()
  )
    return;
  const head = store.getState().refs.head;
  if (
    head.state !== 'attached' ||
    head.branch !== editor.headBranch ||
    head.oid !== editor.headOid
  ) {
    store.getState().patchRewordEditor(editor.token, { error: S.shortcuts.rewordChanged });
    return;
  }
  store.getState().patchRewordEditor(editor.token, { phase: 'saving', error: null });
  let completed = false;
  try {
    const outcome = await store.getState().rewordCommit(request.oid, editor.message, editor);
    if (outcome === null) {
      const error = store.getState().actionError ?? S.shortcuts.rewordFailed;
      store.getState().patchRewordEditor(editor.token, { phase: 'editing', error });
      if (useAppStore.getState().activeSessionId !== request.folderId) {
        useAppStore.getState().notice({
          kind: 'error',
          title: S.shortcuts.rewordTarget(request.repoPath, request.oid.slice(0, 8)),
          message: error,
        });
      }
      return;
    }
    completed = true;
    const folder = getFolderStore(request.folderId);
    folder?.getState().clearTimelineSelection(request.repoPath, request.oid);
    await Promise.all([
      folder?.getState().refresh(),
      folder?.getState().timeline.opened ? folder.getState().reloadTimeline() : undefined,
    ]);
  } catch (error) {
    const message = describeError(error);
    if (!completed)
      store.getState().patchRewordEditor(editor.token, { phase: 'editing', error: message });
    useAppStore.getState().notice({ kind: 'error', title: S.shortcuts.rewordFailed, message });
  } finally {
    if (completed) finishRewordRequest(request);
  }
}
