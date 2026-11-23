import type { FsFile } from '@mgit/ipc';
import { formatBytes, S } from '@mgit/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canHighlight,
  countLines,
  type FileLoad,
  FileView,
  maxColumns,
  splitLines,
  stripBom,
} from '../features/workspace/FileView';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

afterEach(cleanup);

/** 받은 결과 */
const loaded = (file: FsFile): FileLoad => ({ state: 'loaded', file });

/** 파일 보기를 그린다 */
function show(load: FileLoad, path = 'api/src/Main.java', onRetry = vi.fn()) {
  const view = render(<FileView path={path} load={load} onRetry={onRetry} />);
  return { ...view, onRetry };
}

/** 본문 영역의 글자 */
const bodyText = () => screen.getByTestId('file-text').textContent ?? '';

describe('텍스트 다루기 (순수 함수)', () => {
  it('BOM 을 떼고, CRLF·CR·LF 를 모두 줄 끝으로 본다', () => {
    expect(stripBom('﻿hello')).toEqual({ text: 'hello', bom: true });
    expect(stripBom('hello')).toEqual({ text: 'hello', bom: false });
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('a\n')).toEqual(['a', '']);
    for (const text of ['', 'a', 'a\r\nb\r\n', 'a\rb\r', '\n\n']) {
      expect(countLines(text)).toBe(splitLines(text).length);
    }
  });

  it('가장 긴 줄의 화면 칸 수: 탭은 다음 탭 자리까지, 한글은 두 칸', () => {
    expect(maxColumns(['abc', 'abcdef'])).toBe(6);
    expect(maxColumns(['\tx'])).toBe(5);
    expect(maxColumns(['ab\tx'])).toBe(5);
    expect(maxColumns(['한글', 'abc'])).toBe(4);
    expect(maxColumns([])).toBe(0);
  });

  it('구문 강조는 5,000줄·128 KiB 이하만', () => {
    expect(canHighlight(5_000, 128 * 1024)).toBe(true);
    expect(canHighlight(5_001, 10)).toBe(false);
    expect(canHighlight(1, 128 * 1024 + 1)).toBe(false);
  });
});

describe('FileView — 상태를 구분해 보인다 (ED-04)', () => {
  it('읽는 중', () => {
    show({ state: 'loading' });
    expect(screen.getByText(S.fileView.loading)).toBeTruthy();
  });

  it('텍스트: 줄 번호와 내용, 머리줄에 경로 부스러기와 크기', () => {
    show(loaded({ kind: 'text', text: 'class Main {\n}\n', size: 15 }));
    expect(bodyText()).toContain('1class Main {');
    expect(bodyText()).toContain('2}');
    expect(screen.getAllByRole('region', { name: S.fileView.content })).toHaveLength(1);
    const crumbs = screen.getByRole('navigation');
    expect([...crumbs.children].map((c) => c.textContent)).toEqual(['api', 'src', 'Main.java']);
    expect(screen.getByText(formatBytes(15))).toBeTruthy();
  });

  it('빈 텍스트 파일', () => {
    show(loaded({ kind: 'text', text: '', size: 0 }));
    expect(screen.getByText(S.fileView.emptyFile)).toBeTruthy();
  });

  it('바이너리·UTF-8 아님·너무 큼(실제 크기와 상한)', () => {
    show(loaded({ kind: 'binary', size: 18_432 }));
    expect(screen.getByText(S.fileView.binary(formatBytes(18_432)))).toBeTruthy();
    cleanup();
    show(loaded({ kind: 'notUtf8', size: 2_816 }));
    expect(screen.getByText(S.fileView.notUtf8(formatBytes(2_816)))).toBeTruthy();
    cleanup();
    show(loaded({ kind: 'tooLarge', size: 48_234_496, limit: 1_048_576 }));
    expect(screen.getByText(S.fileView.tooLarge('46 MB', '1.0 MB'))).toBeTruthy();
    // 머리줄의 크기도 실제 크기다
    expect(screen.getByText('46 MB')).toBeTruthy();
  });

  it('지원 안 함: 링크·특수 파일은 종류별 문구', () => {
    show(loaded({ kind: 'unsupported', fileKind: 'symlink' }));
    expect(screen.getByText(S.fileView.unsupported.symlink)).toBeTruthy();
    cleanup();
    show(loaded({ kind: 'unsupported', fileKind: 'other' }));
    expect(screen.getByText(S.fileView.unsupported.other)).toBeTruthy();
  });

  it('없음(지워짐)·권한 없음', () => {
    show(loaded({ kind: 'missing' }));
    expect(screen.getByText(S.fileView.missing)).toBeTruthy();
    cleanup();
    show(loaded({ kind: 'denied' }));
    expect(screen.getByText(S.fileView.denied)).toBeTruthy();
  });

  it('오류는 다시 시도를 둔다', () => {
    const { onRetry } = show({ state: 'error', error: 'session closed' });
    expect(screen.getByText(S.fileView.failed('session closed'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: S.fileView.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('저장소 안 파일이면(진입을 받으면) 머리줄에 히스토리·Blame, 아니면 없다 (ED-04, W13)', () => {
    show(loaded({ kind: 'text', text: 'x', size: 1 }));
    expect(screen.queryByRole('button', { name: S.fileView.history })).toBeNull();
    expect(screen.queryByRole('button', { name: S.fileView.blame })).toBeNull();
    cleanup();
    const tools = {
      repoName: 'api',
      path: 'src/Main.java',
      onHistory: vi.fn(),
      onBlame: vi.fn(),
    };
    render(
      <FileView
        path="api/src/Main.java"
        load={loaded({ kind: 'text', text: 'x', size: 1 })}
        onRetry={vi.fn()}
        repoTools={tools}
      />,
    );
    const history = screen.getByRole('button', { name: S.fileView.history });
    expect(history.getAttribute('title')).toBe(S.fileView.historyTip('api', 'src/Main.java'));
    fireEvent.click(history);
    fireEvent.click(screen.getByRole('button', { name: S.fileView.blame }));
    expect(tools.onHistory).toHaveBeenCalledTimes(1);
    expect(tools.onBlame).toHaveBeenCalledTimes(1);
  });
});

describe('FileView — 텍스트로만 그린다 (FS-14)', () => {
  it('스크립트·HTML·SVG·링크 문자열이 글자 그대로 보이고 요소가 되지 않는다', () => {
    const text = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(2)">',
      '<svg onload="alert(3)"><circle r="5"/></svg>',
      '<a href="https://example.com">https://example.com</a>',
      '<b>굵게?</b> &amp; &lt;',
    ].join('\n');
    const { container } = show(loaded({ kind: 'text', text, size: text.length }), 'page.html');
    for (const tag of ['script', 'img', 'svg', 'circle', 'a', 'b', 'iframe']) {
      expect(container.querySelector(`[data-testid="file-text"] ${tag}`), tag).toBeNull();
    }
    for (const line of text.split('\n')) {
      expect(bodyText()).toContain(line);
    }
  });

  it('BOM 은 이상한 글자로 보이지 않고 머리줄에 표시만 하며, CRLF 는 줄로 나뉜다', () => {
    show(loaded({ kind: 'text', text: '﻿first\r\nsecond\r\n', size: 18 }), 'a.txt');
    expect(bodyText()).not.toContain('﻿');
    expect(bodyText()).not.toContain('\r');
    expect(bodyText()).toContain('1first');
    expect(bodyText()).toContain('2second');
    expect(screen.getByText(S.fileView.bom)).toBeTruthy();
  });

  it('큰 텍스트는 보이는 줄만 DOM 에 두고, 구문 강조를 하지 않는다고 알린다', () => {
    const text = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    show(loaded({ kind: 'text', text, size: text.length }), 'big.log');
    const lines = screen.getByTestId('file-text').querySelectorAll('[style*="translateY"]');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThan(120);
    expect(screen.getByText(S.fileView.noHighlight)).toBeTruthy();
  });
});
