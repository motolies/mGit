import type { GraphRangeCache, GraphSlice } from '@mgit/ipc';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/** 범위 요청 시 앞뒤로 더 받아 두는 행 수 (청크 하나) */
const PREFETCH_ROWS = 500;

/**
 * 캐시를 구독해 [start, end) 슬라이스를 돌려주고, 누락분을 요청한다.
 * `ensureRange` 는 멱등이라 StrictMode 의 effect 이중 실행에 안전하다.
 */
export function useGraphWindow(cache: GraphRangeCache, start: number, end: number): GraphSlice {
  const subscribe = useCallback((listener: () => void) => cache.subscribe(listener), [cache]);
  const getSnapshot = useCallback(() => cache.getVersion(), [cache]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // 렌더마다 누락 청크를 확인한다. 이미 있으면 Map 조회만 하고 끝난다
  useEffect(() => {
    void cache.ensureRange(start - PREFETCH_ROWS, end + PREFETCH_ROWS);
  });

  return cache.slice(start, end);
}
