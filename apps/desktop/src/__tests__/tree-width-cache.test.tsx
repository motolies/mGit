// 트리 가로 폭 측정의 글자 폭 캐시 (F3, R4): 같은 글꼴의 같은 글자는 한 번만 재고, 트리와 무관한 재렌더는 다시 재지
// 않는다. jsdom 에는 canvas 가 없어 `getContext`·`measureText` 를 목으로 세고 ResizeObserver·`document.fonts` 를 흉내 낸다
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type CSSProperties, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTreeWidthCache,
  type TreeWidthRow,
  treeContentWidth,
  useTreeContentWidth,
} from '../components/tree-width';
import { ManagedProjectTree } from '../features/project/ManagedProjectTree';
import type { ProjectTreeProps } from '../features/project/ProjectTree';
import { projectEditStrings } from '../features/project/project-edit-strings';
import { flattenProjectTree } from '../features/project/project-tree-model';
import { installDialogStub, tick } from './dialog-stub';

/** 목 canvas 의 글자 폭: 글자 수 × 글꼴 크기의 절반 (굵게면 1.2배). 크기는 `context.font` 에서 읽는다 (jsdom 기본 16px) */
let scale = 1;
const measured: string[] = [];
const resizeCallbacks = new Set<ResizeObserverCallback>();
let fonts: (EventTarget & { status: string; ready: Promise<unknown> }) | undefined;

class ResizeObserverMock {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {
    resizeCallbacks.add(this.callback);
  }
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}

/** 붙어 있는 ResizeObserver 콜백을 모두 부른다 (요소 크기가 바뀐 것처럼) */
function fireResize(): void {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback([], {} as unknown as ResizeObserver);
  });
}

let clientHeight: PropertyDescriptor | undefined;
beforeEach(() => {
  // 가상 스크롤이 행을 그리도록 트리 높이를 준다
  clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
  clearTreeWidthCache();
  measured.length = 0;
  scale = 1;
  resizeCallbacks.clear();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  let font = '';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        get font() {
          return font;
        },
        set font(value: string) {
          font = value;
        },
        measureText(text: string) {
          measured.push(text);
          const size = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '12');
          const bold = font.startsWith('600');
          return { width: Array.from(text).length * (size / 2) * (bold ? 1.2 : 1) * scale };
        },
      }) as unknown as CanvasRenderingContext2D,
  );
  fonts = Object.assign(new EventTarget(), { status: 'loaded', ready: Promise.resolve() });
  Object.defineProperty(document, 'fonts', { configurable: true, get: () => fonts });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

/** 이름이 다른 행 `n` 개 (앞의 하나는 굵게) */
function rowsOf(n: number, prefix = 'file'): TreeWidthRow[] {
  return Array.from({ length: n }, (_, i) => ({
    depth: i % 4,
    icons: 2,
    texts: [{ text: `${prefix}-${String(i).padStart(4, '0')}.ts`, bold: i === 0 }],
  }));
}

/** 훅만 쓰는 시험용 트리 요소. 폭을 `data-width` 로 드러낸다 */
function Probe({ rows, style }: { rows: readonly TreeWidthRow[]; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useTreeContentWidth(ref, rows);
  return <div ref={ref} data-testid="probe" data-width={width} style={style} />;
}

/** 시험용 트리의 지금 폭 */
function probeWidth(): number {
  return Number(screen.getByTestId('probe').dataset.width);
}

/** 목과 같은 규칙으로 기대 폭을 계산한다 (`treeContentWidth` 는 순수 함수라 그대로 쓴다) */
function expected(rows: readonly TreeWidthRow[], size: number, factor = 1): number {
  return treeContentWidth(
    rows,
    (text, bold) => Array.from(text).length * (size / 2) * (bold ? 1.2 : 1) * factor,
    { indent: 16, icon: 16, gap: 4, padding: 24 },
  );
}

describe('트리 폭 글자 캐시', () => {
  it('같은 내용의 새 행 배열로 다시 그려도 다시 재지 않는다', () => {
    const rows = rowsOf(300);
    const { rerender } = render(<Probe rows={rows} />);
    expect(measured.length).toBe(300);
    expect(probeWidth()).toBe(expected(rows, 16));
    measured.length = 0;
    rerender(<Probe rows={rows} />);
    rerender(<Probe rows={rows.map((row) => ({ ...row }))} />);
    fireResize();
    expect(measured.length).toBe(0);
    expect(probeWidth()).toBe(expected(rows, 16));
  });

  it('행 하나가 더해지면 새 글자만 잰다', () => {
    const rows = rowsOf(300);
    const { rerender } = render(<Probe rows={rows} />);
    measured.length = 0;
    const more = [...rows, { depth: 9, icons: 2, texts: [{ text: 'z/new-longest-name.ts' }] }];
    rerender(<Probe rows={more} />);
    expect(measured).toEqual(['z/new-longest-name.ts']);
    expect(probeWidth()).toBe(expected(more, 16));
  });

  it('글자 크기·글꼴 이름이 바뀌면 다시 재고 폭이 갱신된다', () => {
    const rows = rowsOf(50);
    const { rerender } = render(<Probe rows={rows} style={{ fontSize: '12px' }} />);
    measured.length = 0;
    rerender(<Probe rows={rows} style={{ fontSize: '16px' }} />);
    fireResize();
    expect(measured.length).toBe(50);
    expect(probeWidth()).toBe(expected(rows, 16));
    measured.length = 0;
    rerender(<Probe rows={rows} style={{ fontSize: '16px', fontFamily: 'Other' }} />);
    fireResize();
    expect(measured.length).toBe(50);
    // 처음 글꼴로 돌아오면 캐시에 남은 값을 쓴다
    measured.length = 0;
    rerender(<Probe rows={rows} style={{ fontSize: '12px' }} />);
    fireResize();
    expect(measured.length).toBe(0);
    expect(probeWidth()).toBe(expected(rows, 12));
  });

  it('글꼴 로딩이 끝나면 캐시를 비우고 새 글꼴로 다시 잰다', () => {
    const rows = rowsOf(40);
    render(<Probe rows={rows} />);
    measured.length = 0;
    scale = 1.5;
    act(() => {
      fonts?.dispatchEvent(new Event('loadingdone'));
    });
    expect(measured.length).toBe(40);
    expect(probeWidth()).toBe(expected(rows, 16, 1.5));
  });

  it('여러 트리가 같은 글자를 쓰면 처음 한 번만 잰다', () => {
    const rows = rowsOf(100);
    render(
      <>
        <Probe rows={rows} />
        <Probe rows={rows.map((row) => ({ ...row }))} />
      </>,
    );
    expect(measured.length).toBe(100);
  });
});

/** Project 트리 행 `n` 개 (펼친 루트 아래 파일들) */
function projectRows(n: number) {
  const entries = Array.from({ length: n }, (_, i) => ({
    name: `module-${String(i).padStart(4, '0')}.ts`,
    kind: 'file' as const,
    size: 10,
    mtimeMs: 0,
    openable: true,
  }));
  return flattenProjectTree(
    {
      '': {
        load: { state: 'listed', entries, total: n, truncated: false, nonUtf8Names: 0 },
        limit: null,
        pending: false,
      },
    },
    { '': true },
  );
}

describe('Project 트리 폭 측정', () => {
  /** 컨테이너 콜백을 갖춘 Project 트리 props */
  function props(n: number): ProjectTreeProps {
    return {
      root: { name: 'project', detail: '/w' },
      rows: projectRows(n),
      selected: null,
      decorate: () => null,
      onSelect: vi.fn(),
      onToggle: vi.fn(),
      onOpenFile: vi.fn(),
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
      menu: () => [],
      onRefresh: vi.fn(),
      busy: false,
    };
  }

  it('트리와 무관한 이유로 다시 그려도 다시 재지 않는다', () => {
    const base = props(500);
    const { rerender } = render(<ManagedProjectTree {...base} session={1} />);
    expect(measured.length).toBeGreaterThan(500);
    measured.length = 0;
    rerender(<ManagedProjectTree {...base} notice="다른 영역의 변화" session={1} />);
    rerender(<ManagedProjectTree {...base} busy session={1} />);
    expect(measured.length).toBe(0);
  });

  it('새 항목 입력 줄이 끼어든 뒤 이름을 입력하는 동안 다시 재지 않는다', async () => {
    installDialogStub();
    const base = props(200);
    render(<ManagedProjectTree {...base} session={1} />);
    const t = projectEditStrings();
    fireEvent.click(screen.getByRole('button', { name: t.newFile }));
    await tick();
    measured.length = 0;
    const input = screen.getByRole('textbox', { name: t.name });
    for (const name of ['n', 'ne', 'new', 'new.', 'new.t', 'new.ts'])
      fireEvent.change(input, { target: { value: name } });
    expect(measured.length).toBe(0);
  });
});
