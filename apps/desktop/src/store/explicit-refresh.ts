// 사용자가 고른 새로고침의 차례 (반응성 G1). 파일 트리의 epoch 는 창 포커스·ref 변경·저장 뒤 등 다시 읽을 때마다 오르므로,
// "명시적 새로고침에만" 할 일(편집기의 Blame·HEAD 원문 재조회, 미리보기 그림 캐시 교체)은 이 차례를 본다.
import type { SessionId } from '@mgit/ipc';
import { useCallback, useSyncExternalStore } from 'react';

const seqs = new Map<SessionId, number>();
const listeners = new Set<() => void>();

/** 그 탭(세션)에서 사용자가 새로고침을 골랐다 (⌘R·새로고침 단추·트리 메뉴) */
export function markExplicitRefresh(session: SessionId): void {
  seqs.set(session, (seqs.get(session) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/** 그 탭의 명시적 새로고침 차례 (고른 적이 없으면 0) */
export function explicitRefreshSeq(session: SessionId): number {
  return seqs.get(session) ?? 0;
}

/** 그 탭의 명시적 새로고침 차례를 구독한다. 세션이 없으면 0 */
export function useExplicitRefresh(session: SessionId | null | undefined): number {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useSyncExternalStore(subscribe, () =>
    session === null || session === undefined ? 0 : explicitRefreshSeq(session),
  );
}
