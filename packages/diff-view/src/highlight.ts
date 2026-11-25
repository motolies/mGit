import type { Parser } from '@lezer/common';
import {
  classHighlighter,
  type Highlighter,
  highlightCode,
  tagHighlighter,
  tags,
} from '@lezer/highlight';
import type { Hunk } from '@mgit/ipc';
import type { Span } from './word-diff';

export { parserFor } from './languages';

const markdownHighlighter = tagHighlighter([
  { tag: tags.monospace, class: 'tok-monospace' },
  { tag: tags.strikethrough, class: 'tok-strikethrough' },
]);

/** 기본 토큰 클래스에 Markdown 인라인 코드·취소선만 보완해 모든 화면에서 공유한다. */
export const codeHighlighter: Highlighter = {
  style(tags) {
    return (
      [classHighlighter.style(tags), markdownHighlighter.style(tags)].filter(Boolean).join(' ') ||
      null
    );
  },
};

/** 텍스트를 파싱해 줄별 구문 조각으로 바꾼다 (`tok-*` 클래스) */
export function tokenize(parser: Parser, text: string): Span[][] {
  const tree = parser.parse(text);
  const lines: Span[][] = [[]];
  highlightCode(
    text,
    tree,
    codeHighlighter,
    (code, cls) => {
      lines[lines.length - 1]?.push({ text: code, cls });
    },
    () => {
      lines.push([]);
    },
  );
  return lines;
}

/**
 * hunk 하나를 줄 인덱스 → 구문 조각으로 강조한다.
 * 새 쪽(컨텍스트+추가)과 옛 쪽(컨텍스트+삭제)을 따로 파싱해 각 줄에 맞는 쪽을 쓴다
 */
export function highlightHunk(parser: Parser, h: Hunk): Map<number, Span[]> {
  const result = new Map<number, Span[]>();
  const newIdx: number[] = [];
  const oldIdx: number[] = [];
  h.lines.forEach((l, i) => {
    if (l.kind !== 'del') {
      newIdx.push(i);
    }
    if (l.kind !== 'add') {
      oldIdx.push(i);
    }
  });
  const newText = newIdx.map((i) => h.lines[i]?.text ?? '').join('\n');
  const oldText = oldIdx.map((i) => h.lines[i]?.text ?? '').join('\n');
  const newSpans = tokenize(parser, newText);
  newIdx.forEach((li, k) => {
    const spans = newSpans[k];
    if (spans) {
      result.set(li, spans);
    }
  });
  const oldSpans = tokenize(parser, oldText);
  oldIdx.forEach((li, k) => {
    if (h.lines[li]?.kind === 'del') {
      const spans = oldSpans[k];
      if (spans) {
        result.set(li, spans);
      }
    }
  });
  return result;
}

/** 강조 없이 한 줄을 조각 하나로 */
export function plainSpans(text: string): Span[] {
  return text.length === 0 ? [] : [{ text, cls: '' }];
}
