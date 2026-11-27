// 앱 루트(`App`)가 구독하는 좁은 값 (G2). 루트가 다시 그려지면 아래 전체가 함께 다시 그려질 수 있으므로, 루트에는 바뀌는 일이
// 드문 원시값만 구독하게 한다 — 범위 세션 id 처럼 폴더 탭에서 저장소 행을 옮길 때마다 바뀌는 값은 루트가 직접 구독하지 않는다

import type { SessionId } from '@mgit/ipc';
import { useCallback, useSyncExternalStore } from 'react';
import { activeTabKind } from './app-store';
import { useAppStore } from './app-store-instance';
import { scopeSessionId } from './repo-sessions';
import { getWorkspaceStore } from './session-registry';

/**
 * 활성 탭이 저장소 탭이면 그 세션 id, 아니면 null. 동작 레지스트리·단축키는 저장소 탭의 세션에만 대고 돌므로(W13) 폴더 탭의
 * 범위 세션(활성 저장소의 숨은 세션)이 바뀌어도 이 값은 그대로다
 */
export function useRepoTabSessionId(): SessionId | null {
  return useAppStore((s) => (activeTabKind(s) === 'repo' ? s.activeSessionId : null));
}

/**
 * 범위 세션이 있는지 (`useHasSession` 과 같은 판정). 앱 스토어(장부)와 활성 탭 워크스페이스(활성 저장소)를 함께 보되, 결과(참·거짓)가
 * 바뀔 때만 다시 그리게 한다 — 폴더 탭에서 숨은 세션이 열린 저장소끼리 옮겨 다니면 범위 세션 id 는 바뀌어도 이 값은 같다
 */
export function useHasScopeSession(): boolean {
  const id = useAppStore((s) => s.activeSessionId);
  const workspace = id === null ? undefined : getWorkspaceStore(id);
  // 두 스토어 중 하나라도 바뀌면 다시 계산한다 (값이 같으면 React 가 다시 그리지 않는다)
  const subscribe = useCallback(
    (notify: () => void) => {
      const offApp = useAppStore.subscribe(notify);
      const offWorkspace = workspace?.subscribe(notify);
      return () => {
        offApp();
        offWorkspace?.();
      };
    },
    [workspace],
  );
  // 지금 범위 세션이 있는지 계산한다
  const snapshot = () => {
    const s = useAppStore.getState();
    const meta = s.activeSessionId === null ? undefined : s.sessions[s.activeSessionId];
    return (
      scopeSessionId({
        tab: meta ? { id: meta.id, kind: meta.kind } : null,
        ledgers: s.repoSessions,
        activeRepo: workspace?.getState().activeRepo ?? null,
      }) !== null
    );
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
