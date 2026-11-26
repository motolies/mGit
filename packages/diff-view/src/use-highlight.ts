import type { FileDiff } from '@mgit/ipc';
import { useEffect, useMemo, useState } from 'react';
import { highlightHunk, tokenize } from './highlight';
import { isMarkdownPath, parserFor } from './languages';
import type { Span } from './word-diff';

/** hunk 번호 → (줄 인덱스 → 조각) */
export type HighlightMap = Map<number, Map<number, Span[]>>;

const EMPTY_HIGHLIGHT: HighlightMap = new Map();

const MAX_HIGHLIGHT_LINES = 5000;
const MAX_HIGHLIGHT_CHARS = 128 * 1024;

/** 원문이 있으면 양쪽 전체를 별도로 파싱하고, 없으면 각 hunk의 확인 가능한 문맥만 쓴다. */
export async function highlightDiff(
  diff: FileDiff,
  path: string,
  originals?: { old: string; new: string },
): Promise<HighlightMap> {
  const result: HighlightMap = new Map();
  if (diff.binary || diff.totalLines > MAX_HIGHLIGHT_LINES) return result;
  const markdown = isMarkdownPath(path);
  const useOriginals =
    originals &&
    originals.old.split('\n').length + originals.new.split('\n').length <= MAX_HIGHLIGHT_LINES;
  // Markdown 원문 상한을 넘으면 문맥을 잘라 잘못된 코드 블록으로 해석하지 않는다.
  if (
    markdown &&
    originals &&
    (!useOriginals || originals.old.length + originals.new.length > MAX_HIGHLIGHT_CHARS)
  ) {
    return result;
  }
  const texts =
    useOriginals && originals
      ? [originals.old, originals.new]
      : diff.hunks.flatMap((hunk) =>
          ['add', 'del'].map((exclude) =>
            hunk.lines
              .filter((line) => line.kind !== exclude)
              .map((line) => line.text)
              .join('\n'),
          ),
        );
  if (markdown && texts.reduce((size, text) => size + text.length, 0) > MAX_HIGHLIGHT_CHARS) {
    return result;
  }
  const parser = await parserFor(path, texts);
  if (!parser) return result;
  if (useOriginals && originals) {
    const oldSpans = tokenize(parser, originals.old);
    const newSpans = tokenize(parser, originals.new);
    result.set(-1, new Map(oldSpans.map((spans, index) => [index, spans])));
    result.set(-2, new Map(newSpans.map((spans, index) => [index, spans])));
    diff.hunks.forEach((h, i) => {
      const lines = new Map<number, Span[]>();
      h.lines.forEach((line, j) => {
        const spans =
          line.kind === 'del' ? oldSpans[(line.oldNo ?? 0) - 1] : newSpans[(line.newNo ?? 0) - 1];
        if (spans) lines.set(j, spans);
      });
      result.set(i, lines);
    });
  } else {
    diff.hunks.forEach((h, i) => {
      result.set(i, highlightHunk(parser, h));
    });
  }
  return result;
}

/** diff를 비동기로 강조하고 파일·초안 변경 전에 시작한 결과는 버린다. */
export function useHighlight(
  diff: FileDiff | null,
  path: string,
  originals?: { old: string; new: string },
): HighlightMap {
  const key = useMemo(() => JSON.stringify([path, diff, originals]), [path, diff, originals]);
  const [result, setResult] = useState<{ key: string; map: HighlightMap }>(() => ({
    key: '',
    map: new Map(),
  }));
  useEffect(() => {
    let cancelled = false;
    if (result.key === key) return;
    if (diff) {
      void highlightDiff(diff, path, originals).then((next) => {
        if (!cancelled) setResult({ key, map: next });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [diff, path, originals, key, result.key]);
  // 내용이 같으면 완료된 강조를 유지하고, 다른 파일에는 이전 색상 지도를 노출하지 않는다.
  return result.key === key ? result.map : EMPTY_HIGHLIGHT;
}
