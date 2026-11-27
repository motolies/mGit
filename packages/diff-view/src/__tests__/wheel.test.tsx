// 반응성 F-2: diff 본문 휠. 세로는 브라우저 기본 스크롤에 맡기고(리스너 passive, 취소 없음), 가로로 보는 휠(가로 성분이 더 큰
// 휠·Shift+휠)만 아래 막대를 옮긴다. 한 제스처 안에서는 처음 정한 축을 지킨다
import type { FileDiff } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../DiffView';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 긴 줄 하나가 바뀐 diff */
function diff(): FileDiff {
  return {
    oldPath: 'a.txt',
    newPath: 'a.txt',
    change: { kind: 'modified' },
    binary: null,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        section: '',
        lines: [
          { kind: 'del', text: `old ${'x'.repeat(400)}`, oldNo: 1, newNo: null, noNewline: false },
          { kind: 'add', text: `new ${'y'.repeat(400)}`, oldNo: null, newNo: 1, noNewline: false },
        ],
      },
    ],
    truncated: false,
    totalLines: 2,
    nonUtf8: false,
  } as unknown as FileDiff;
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

/** 시계를 손으로 옮긴다 (제스처 간격) */
function clock(start = 1000) {
  let now = start;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return (ms: number) => {
    now += ms;
  };
}

describe('diff 본문 휠 (F-2)', () => {
  it('휠 리스너는 passive 라 세로 스크롤을 기다리게 하지 않는다', async () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    render(<DiffView diff={diff()} path="a.txt" mode="split" />);
    await flush();
    const wheel = add.mock.calls.filter(([type]) => type === 'wheel');
    expect(wheel.length).toBeGreaterThan(0);
    for (const [, , options] of wheel) expect(options).toMatchObject({ passive: true });
  });

  it('세로가 큰 휠은 가로 성분이 섞여도 취소하지 않고 가로 위치를 바꾸지 않는다', async () => {
    clock();
    render(<DiffView diff={diff()} path="a.txt" mode="split" />);
    await flush();
    const right = screen.getByRole('region', { name: S.diff.newHorizontalScroll });
    const code = document.querySelector('[data-side="right"]');
    if (!code) throw new Error('오른쪽 코드 없음');
    // 트랙패드가 세로로 굴릴 때 섞는 작은 가로 성분
    const notPrevented = fireEvent.wheel(code, { deltaX: 2, deltaY: 40 });
    expect(notPrevented).toBe(true);
    expect(right.scrollLeft).toBe(0);
  });

  it('가로가 큰 휠은 그 쪽 막대를 옮기고, 좌우 동기면 막대의 scroll 로 양쪽 코드를 옮긴다', async () => {
    clock();
    render(<DiffView diff={diff()} path="a.txt" mode="split" />);
    await flush();
    const left = screen.getByRole('region', { name: S.diff.oldHorizontalScroll });
    const right = screen.getByRole('region', { name: S.diff.newHorizontalScroll });
    const code = document.querySelector('[data-side="right"]');
    if (!code) throw new Error('오른쪽 코드 없음');
    expect(fireEvent.wheel(code, { deltaX: 60, deltaY: 3 })).toBe(true);
    expect(right.scrollLeft).toBe(60);
    fireEvent.scroll(right);
    expect(left.scrollLeft).toBe(60);
    const style = right.closest('[style*="--diff-split"]')?.getAttribute('style') ?? '';
    expect(style).toContain('--diff-right-scroll: 60px');
    expect(style).toContain('--diff-left-scroll: 60px');
  });

  it('한 제스처 안에서는 처음 정한 축을 지키고, 간격을 두면 새 제스처로 본다', async () => {
    const advance = clock();
    render(<DiffView diff={diff()} path="a.txt" mode="split" horizontalSync={false} />);
    await flush();
    const right = screen.getByRole('region', { name: S.diff.newHorizontalScroll });
    const code = document.querySelector('[data-side="right"]');
    if (!code) throw new Error('오른쪽 코드 없음');
    fireEvent.wheel(code, { deltaX: 1, deltaY: 30 });
    advance(16);
    // 세로로 굴리던 손가락이 잠깐 옆으로 흔들려도 세로 제스처다
    fireEvent.wheel(code, { deltaX: 40, deltaY: 5 });
    expect(right.scrollLeft).toBe(0);
    advance(500);
    fireEvent.wheel(code, { deltaX: 40, deltaY: 5 });
    expect(right.scrollLeft).toBe(40);
  });

  it('Shift+휠은 세로 제스처 중이어도 가로로 옮기고, Shift 를 누르는 동안만 세로 성분뿐인 휠의 세로 스크롤을 막는다', async () => {
    const advance = clock();
    render(<DiffView diff={diff()} path="a.txt" mode="split" horizontalSync={false} />);
    await flush();
    const left = screen.getByRole('region', { name: S.diff.oldHorizontalScroll });
    const code = document.querySelector('[data-side="left"]');
    if (!code) throw new Error('왼쪽 코드 없음');
    expect(fireEvent.wheel(code, { deltaY: 30 })).toBe(true);
    advance(16);
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    // OS 가 가로로 바꿔 주지 않으면 Shift+휠은 deltaY 로 온다 — 세로로는 움직이지 않게 취소한다
    expect(fireEvent.wheel(code, { deltaY: 50, shiftKey: true })).toBe(false);
    expect(left.scrollLeft).toBe(50);
    // macOS 는 Shift+마우스 휠을 가로(deltaX)로 바꿔 준다 — 취소할 것이 없다
    expect(fireEvent.wheel(code, { deltaX: 25, shiftKey: true })).toBe(true);
    expect(left.scrollLeft).toBe(75);
    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
    advance(500);
    expect(fireEvent.wheel(code, { deltaY: 30 })).toBe(true);
    expect(left.scrollLeft).toBe(75);
  });
});
