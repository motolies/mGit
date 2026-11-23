import type { FileDiff } from '@mgit/ipc';
import { useEffect, useState } from 'react';
import { highlightHunk, parserFor } from './highlight';
import type { Span } from './word-diff';

/** hunk 번호 → (줄 인덱스 → 조각) */
export type HighlightMap = Map<number, Map<number, Span[]>>;

/** 큰 diff 는 강조를 건너뛴다 (줄 수 기준) */
const MAX_HIGHLIGHT_LINES = 5000;

/** diff 를 비동기로 구문 강조한다. 언어를 모르거나 너무 크면 빈 맵 */
export function useHighlight(diff: FileDiff | null, path: string): HighlightMap {
  const [map, setMap] = useState<HighlightMap>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    setMap(new Map());
    if (!diff || diff.binary || diff.totalLines > MAX_HIGHLIGHT_LINES) {
      return;
    }
    void parserFor(path).then((parser) => {
      if (cancelled || !parser) {
        return;
      }
      const next: HighlightMap = new Map();
      diff.hunks.forEach((h, i) => {
        next.set(i, highlightHunk(parser, h));
      });
      if (!cancelled) {
        setMap(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [diff, path]);
  return map;
}
