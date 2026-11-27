import type { Parser } from '@lezer/common';
import type { FileDiff } from '@mgit/ipc';
import { useEffect, useMemo, useState } from 'react';
import { highlightHunk, tokenize } from './highlight';
import { isMarkdownPath, loadedParser, parserFor } from './languages';
import type { Span } from './word-diff';

/** hunk 번호 → (줄 인덱스 → 조각) */
export type HighlightMap = Map<number, Map<number, Span[]>>;

const EMPTY_HIGHLIGHT: HighlightMap = new Map();

const MAX_HIGHLIGHT_LINES = 5000;
const MAX_HIGHLIGHT_CHARS = 128 * 1024;

/** 강조할 재료: 이진·상한 초과·Markdown 상한이면 null (강조하지 않는다) */
function highlightPlan(
  diff: FileDiff,
  path: string,
  originals?: { old: string; new: string },
): { texts: string[]; useOriginals: boolean } | null {
  if (diff.binary || diff.totalLines > MAX_HIGHLIGHT_LINES) return null;
  const markdown = isMarkdownPath(path);
  const useOriginals =
    !!originals &&
    originals.old.split('\n').length + originals.new.split('\n').length <= MAX_HIGHLIGHT_LINES;
  // Markdown 원문 상한을 넘으면 문맥을 잘라 잘못된 코드 블록으로 해석하지 않는다.
  if (
    markdown &&
    originals &&
    (!useOriginals || originals.old.length + originals.new.length > MAX_HIGHLIGHT_CHARS)
  ) {
    return null;
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
    return null;
  }
  return { texts, useOriginals };
}

/** 파서로 강조 지도를 만든다: 원문을 쓰면 양쪽 전체를 따로 파싱하고, 아니면 hunk 마다 확인 가능한 문맥만 쓴다 */
function buildHighlight(
  diff: FileDiff,
  parser: Parser,
  useOriginals: boolean,
  originals?: { old: string; new: string },
): HighlightMap {
  const result: HighlightMap = new Map();
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

/** 원문이 있으면 양쪽 전체를 별도로 파싱하고, 없으면 각 hunk의 확인 가능한 문맥만 쓴다. */
export async function highlightDiff(
  diff: FileDiff,
  path: string,
  originals?: { old: string; new: string },
): Promise<HighlightMap> {
  const plan = highlightPlan(diff, path, originals);
  if (!plan) return new Map();
  const parser = await parserFor(path, plan.texts);
  if (!parser) return new Map();
  return buildHighlight(diff, parser, plan.useOriginals, originals);
}

/**
 * 언어를 이미 불러왔으면 바로 강조한다 (E-3). 불러오지 않았으면(또는 Markdown) undefined — 그때는 `highlightDiff` 로 비동기로
 * 한다. 강조할 수 없는 문서는 빈 지도
 */
export function highlightDiffNow(
  diff: FileDiff,
  path: string,
  originals?: { old: string; new: string },
): HighlightMap | undefined {
  const plan = highlightPlan(diff, path, originals);
  if (!plan) return new Map();
  const parser = loadedParser(path);
  if (parser === undefined) return undefined;
  if (parser === null) return new Map();
  return buildHighlight(diff, parser, plan.useOriginals, originals);
}

/** 최근에 만든 강조 지도 (내용 키 → 지도, 몇 개만). 같은 문서를 다시 그리거나 개발 모드가 렌더를 두 번 돌려도 다시 파싱하지 않는다 */
const recent = new Map<string, HighlightMap>();
const RECENT_LIMIT = 4;

/** 최근 강조에 넣는다 (오래된 것부터 버린다) */
function remember(key: string, map: HighlightMap): void {
  recent.delete(key);
  recent.set(key, map);
  while (recent.size > RECENT_LIMIT) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

/**
 * diff 를 강조하고 파일·초안 변경 전에 시작한 결과는 버린다. 언어를 이미 불러왔으면 문서가 그려지는 그 렌더에서 바로 강조해,
 * 강조만 따로 도착해 보이는 행을 한 번 더 그리던 커밋(과 강조 없는 글자가 잠깐 보이던 것)을 없앤다 (E-3)
 */
export function useHighlight(
  diff: FileDiff | null,
  path: string,
  originals?: { old: string; new: string },
): HighlightMap {
  const key = useMemo(() => JSON.stringify([path, diff, originals]), [path, diff, originals]);
  const now = useMemo(() => {
    if (!diff) return undefined;
    const cached = recent.get(key);
    if (cached) return cached;
    const map = highlightDiffNow(diff, path, originals);
    if (map) remember(key, map);
    return map;
  }, [key, diff, path, originals]);
  const [result, setResult] = useState<{ key: string; map: HighlightMap }>(() => ({
    key: '',
    map: new Map(),
  }));
  useEffect(() => {
    let cancelled = false;
    if (now !== undefined || result.key === key) return;
    if (diff) {
      void highlightDiff(diff, path, originals).then((next) => {
        if (cancelled) return;
        remember(key, next);
        setResult({ key, map: next });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [diff, path, originals, key, result.key, now]);
  // 내용이 같으면 완료된 강조를 유지하고, 다른 파일에는 이전 색상 지도를 노출하지 않는다.
  return now ?? (result.key === key ? result.map : EMPTY_HIGHLIGHT);
}
