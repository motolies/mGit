import type { ReactNode } from 'react';

/**
 * 글자에서 맞은 위치(UTF-16 위치, 오름차순)를 `<mark>` 로 감싼다 — 이어진 위치는 한 덩어리다. 빠른 열기(⌘P) 결과 줄과
 * Project 트리 이름 필터가 함께 쓴다. 어떻게 보일지는 쓰는 쪽의 CSS 가 정한다
 */
export function MatchedText({ text, positions }: { text: string; positions: readonly number[] }) {
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 0; i < positions.length; i++) {
    const from = positions[i] ?? 0;
    let to = from + 1;
    while (positions[i + 1] === to) {
      to++;
      i++;
    }
    if (from > start) parts.push(text.slice(start, from));
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>);
    start = to;
  }
  if (start < text.length) parts.push(text.slice(start));
  return <span>{parts}</span>;
}
