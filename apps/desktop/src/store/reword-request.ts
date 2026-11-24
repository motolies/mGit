import type { SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { create } from 'zustand';
import { useAppStore } from './app-store-instance';
import { getSessionStore } from './session-registry';

interface RewordRequest {
  sessionId: SessionId;
  oid: string;
  signal: AbortSignal;
}

/** 폴더 화면이 내려가도 유지되는 메시지 수정 요청. 탭 이동·닫기는 구독에서 취소한다. */
export const useRewordRequest = create<{ request: RewordRequest | null }>(() => ({
  request: null,
}));
let pending: { key: string; cancel: () => void } | null = null;

/** 요청 소비 뒤 구독과 취소 신호를 정리한다. */
export function finishRewordRequest(request: RewordRequest): void {
  if (useRewordRequest.getState().request === request) {
    pending?.cancel();
  }
}

/** 그래프 로드 완료·실패·취소를 기다린다. 기다리는 동안 타이머나 화면 컴포넌트를 소유하지 않는다. */
async function waitLoaded(id: SessionId, signal: AbortSignal): Promise<boolean> {
  const store = getSessionStore(id);
  if (!store || signal.aborted) {
    return false;
  }
  if (store.getState().loadState === 'complete') {
    return true;
  }
  if (store.getState().loadState === 'error') {
    return false;
  }
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      unsubscribe();
      signal.removeEventListener('abort', abort);
      resolve(ok);
    };
    const abort = () => finish(false);
    const unsubscribe = store.subscribe((state) => {
      if (state.loadState === 'complete' || state.loadState === 'error') {
        finish(state.loadState === 'complete');
      }
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** 폴더의 커밋을 저장소 로그로 옮긴 뒤 같은 수정 명령을 요청한다. 반복 입력은 하나로 합친다. */
export async function requestRepoReword(
  folderId: SessionId,
  path: string,
  oid: string,
): Promise<void> {
  const key = `${folderId}:${path}:${oid}`;
  if (pending?.key === key) {
    return;
  }
  pending?.cancel();
  const controller = new AbortController();
  let expectedId = folderId;
  let activating = false;
  const cancel = () => {
    controller.abort();
    unsubscribe();
    useRewordRequest.setState({ request: null });
    if (pending?.key === key) {
      pending = null;
    }
  };
  const unsubscribe = useAppStore.subscribe((state) => {
    if (activating && state.activeSessionId !== expectedId && state.activeSessionId !== null) {
      expectedId = state.activeSessionId;
      activating = false;
    } else if (state.activeSessionId !== expectedId || !state.sessions[expectedId]) {
      cancel();
    }
  });
  pending = { key, cancel };
  const app = useAppStore.getState();
  const id = await app.openRepositoryAt(path, folderId, {
    activate: () => {
      activating = !controller.signal.aborted;
      return activating;
    },
  });
  if (controller.signal.aborted) {
    return;
  }
  if (id === null) {
    app.notice({ kind: 'error', title: S.shortcuts.commitLoadFailed });
    cancel();
    return;
  }
  expectedId = id;
  activating = false;
  const loaded = await waitLoaded(id, controller.signal);
  if (controller.signal.aborted) {
    return;
  }
  const result = loaded
    ? await getSessionStore(id)?.getState().jumpToCommit(oid, controller.signal)
    : 'failed';
  if (controller.signal.aborted) {
    return;
  }
  if (result !== 'found') {
    app.notice({
      kind: 'error',
      title: result === 'missing' ? S.shortcuts.commitMissing : S.shortcuts.commitLoadFailed,
    });
    cancel();
    return;
  }
  useRewordRequest.setState({ request: { sessionId: id, oid, signal: controller.signal } });
}
