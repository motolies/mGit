// diff 본문 테스트용 배치 흉내 (반응성 H). jsdom 에는 배치가 없어 가상 스크롤이 읽는 크기와 스크롤 이동을 흉내 내고, 긴 diff
// 픽스처를 준다. `installLayoutStub()` 을 테스트 파일 맨 위에서 부른다
import type { FileDiff, Hunk } from '@mgit/ipc';
import { act, cleanup, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * jsdom 에는 배치가 없어 크기를 흉내 낸다: 본문 600px, 행은 `rowHeight`(hunk 머리 줄은 `hunkHeight`). 스크롤·키보드 테스트는
 * 셈을 쉽게 하려고 머리 줄도 코드 줄과 같은 높이로 두고, 줄 높이 테스트만 다르게 둔다
 */
export const size = { rowHeight: 20, hunkHeight: 20 };
const original = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  scrollTo: Element.prototype.scrollTo,
  ResizeObserver: globalThis.ResizeObserver,
};

/** 크기·스크롤 흉내를 이 테스트 파일의 앞뒤에 건다 */
export function installLayoutStub(): void {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.testid === 'diff-scroller') return 600;
        if (this.dataset.index !== undefined)
          return this.textContent?.startsWith('@@') ? size.hunkHeight : size.rowHeight;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    // 본문의 스크롤 높이 = 가상 스크롤이 잡은 전체 높이 (안쪽 상자의 height)
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element) {
        const inner = this.firstElementChild as HTMLElement | null;
        return Number.parseFloat(inner?.style.height ?? '') || 0;
      },
    });
    // 가상 스크롤의 이동(scrollToIndex)이 본문 위치를 바꾸고 scroll 이벤트를 내게 한다
    Element.prototype.scrollTo = function scrollTo(
      this: Element,
      options?: ScrollToOptions | number,
    ) {
      const top = typeof options === 'number' ? options : options?.top;
      if (top === undefined) return;
      this.scrollTop = top;
      // 브라우저처럼 scroll 이벤트는 다음 차례에 온다
      setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
    } as Element['scrollTo'];
  });

  afterAll(() => {
    if (original.offsetHeight)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original.offsetHeight);
    if (original.clientHeight)
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', original.clientHeight);
    if (original.scrollHeight)
      Object.defineProperty(Element.prototype, 'scrollHeight', original.scrollHeight);
    Element.prototype.scrollTo = original.scrollTo;
  });

  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = original.ResizeObserver;
    size.rowHeight = 20;
    size.hunkHeight = 20;
  });
}

/** 문맥 줄 `n` 개 뒤에 바뀐 줄 한 쌍이 있는 hunk (unified 행: 머리 1 + 문맥 n + 2) */
export function hunk(start: number, n: number, noNewline = false): Hunk {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push({
      kind: 'context',
      text: `line ${start + i}`,
      oldNo: start + i,
      newNo: start + i,
      noNewline: false,
    });
  }
  lines.push({
    kind: 'del',
    text: `old ${start}`,
    oldNo: start + n,
    newNo: null,
    noNewline: false,
  });
  lines.push({ kind: 'add', text: `new ${start}`, oldNo: null, newNo: start + n, noNewline });
  return {
    oldStart: start,
    oldLines: n + 1,
    newStart: start,
    newLines: n + 1,
    section: '',
    lines,
  } as unknown as Hunk;
}

/** hunk 들로 된 diff */
export function diffOf(...hunks: Hunk[]): FileDiff {
  return {
    oldPath: 'a.txt',
    newPath: 'a.txt',
    change: { kind: 'modified' },
    binary: null,
    hunks,
    truncated: false,
    totalLines: 400,
    nonUtf8: false,
  } as unknown as FileDiff;
}

/** 구간 셋짜리 긴 diff: 구간 머리 줄은 0·103·206 행, 변경 덩어리는 101·204·307 행 (unified) */
export const big = () => diffOf(hunk(1, 100), hunk(200, 100), hunk(400, 100));

/**
 * 한 구간(`@@ -75,23 +75,15 @@`) 안에 변경 덩어리가 둘인 문서 (J — 사용자의 그림과 같은 모양): ① 78행 한 줄 바뀜, ② 옛 83~94행
 * 12줄이 새 83~86행 4줄로 바뀜. 옛 파일 300줄, 새 파일 292줄(덩어리 뒤로 스크롤할 자리가 넉넉하다). 덩어리 첫 행 — 통합: 변경 주변 4·10, 전체 파일 78·84 / 좌우: 변경
 * 주변 4·9, 전체 파일 78·83
 */
export function twoChunks() {
  const old = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  const next = [
    ...old.slice(0, 77),
    'new 78',
    ...old.slice(78, 82),
    'new A',
    'new B',
    'new C',
    'new D',
    ...old.slice(94),
  ];
  const context = (oldNo: number, newNo: number) => ({
    kind: 'context',
    text: `line ${oldNo}`,
    oldNo,
    newNo,
    noNewline: false,
  });
  const del = (oldNo: number) => ({
    kind: 'del',
    text: `line ${oldNo}`,
    oldNo,
    newNo: null,
    noNewline: false,
  });
  const add = (newNo: number, text: string) => ({
    kind: 'add',
    text,
    oldNo: null,
    newNo,
    noNewline: false,
  });
  const lines = [
    context(75, 75),
    context(76, 76),
    context(77, 77),
    del(78),
    add(78, 'new 78'),
    ...[79, 80, 81, 82].map((n) => context(n, n)),
    ...Array.from({ length: 12 }, (_, i) => del(83 + i)),
    ...['A', 'B', 'C', 'D'].map((tag, i) => add(83 + i, `new ${tag}`)),
    context(95, 87),
    context(96, 88),
    context(97, 89),
  ];
  const diff = diffOf({
    oldStart: 75,
    oldLines: 23,
    newStart: 75,
    newLines: 15,
    section: '',
    lines,
  } as unknown as Hunk);
  const document = {
    diff,
    revision: 'two-chunks',
    limitReason: null,
    old: { path: 'a.txt', label: 'Old', content: `${old.join('\n')}\n`, lineCount: old.length },
    new: { path: 'a.txt', label: 'New', content: `${next.join('\n')}\n`, lineCount: next.length },
  };
  return { diff, document };
}

export const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
/** 관찰 알림(다음 프레임에 묶어 돈다)과 스크롤 중 표시(150ms)가 끝날 때까지 기다린다 */
export const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 200)));

/** 본문 grid */
export const scroller = () => screen.getByTestId('diff-scroller');
