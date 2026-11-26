import { createNullClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonDoc } from '../features/history/ComparisonDoc';
import { handleGlobalKey } from '../global-keys';
import type { ComparisonTarget } from '../store/workspace-store';
import { documentOf } from './diff-document-fixture';

const state = vi.hoisted(() => ({
  client: null as unknown,
  shortcutOverrides: {},
  tab: null as { id: number; kind: string } | null,
  openSession: vi.fn(),
  repo: { refs: { labels: [] }, status: {}, fetch: async () => {}, busy: false, lastFetchAt: null },
  ws: {
    mode: 'split',
    options: {
      ignoreWhitespace: false,
      context: 3,
      wrap: false,
      tabWidth: 4,
      fullFile: false,
      horizontalSync: true,
      highlightMode: 'word',
    },
    setMode: () => {},
    setOptions: () => {},
  },
}));
vi.mock('../store', () => ({
  useAppStore: Object.assign((select: (s: unknown) => unknown) => select(state), {
    getState: () => ({ withRepoSession: state.openSession }),
  }),
  useSessionOf: (_id: number, select: (s: unknown) => unknown) => select(state.repo),
  useWorkspace: (select: (s: unknown) => unknown) =>
    select({
      diffMode: state.ws.mode,
      diffOptions: state.ws.options,
      setDiffMode: state.ws.setMode,
      setDiffOptions: state.ws.setOptions,
    }),
  useScopeSessionId: () => 1,
  useActiveTab: () => state.tab,
  useSession: () => ({}),
  getSessionStore: () => null,
}));
vi.mock('../features/workspace/use-current-file', () => ({ useCurrentFile: () => vi.fn() }));
vi.mock('../features/history/ComparisonCommits', () => ({ ComparisonCommits: () => null }));
vi.mock('../features/history/comparison', () => ({
  LOCAL: '@LOCAL',
  comparisonDrafts: () => [['a.txt', 'draft']],
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  });
});
afterEach(cleanup);
beforeEach(() => {
  state.tab = null;
  state.client = createNullClient();
  state.repo.status = {};
  state.ws.options = {
    ignoreWhitespace: false,
    context: 3,
    wrap: false,
    tabWidth: 4,
    fullFile: false,
    horizontalSync: true,
    highlightMode: 'word',
  };
});
const doc = (): ComparisonTarget => ({
  kind: 'comparison',
  repoPath: '/repo',
  repoName: 'repo',
  session: 1,
  a: 'main',
  b: 'feature',
  threeDot: false,
});

describe('고정 비교 문서', () => {
  it('파일 목록과 원문은 같은 OID를 사용하며 다시 열어도 명시적 새로고침 전에는 기준을 유지한다', async () => {
    const client = createNullClient();
    client.resolveRevision = vi.fn(async (_session, rev) =>
      rev === 'main' ? 'a'.repeat(40) : 'b'.repeat(40),
    );
    client.compareRefs = vi.fn(async () => [
      { path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } },
    ]);
    client.compareFileDiffDocument = vi.fn(async () => documentOf());
    state.client = client;
    const target = doc();
    const mounted = render(<ComparisonDoc doc={target} />);
    await waitFor(() => expect(client.compareFileDiffDocument).toHaveBeenCalled());
    expect(client.compareRefs).toHaveBeenCalledWith(1, 'a'.repeat(40), 'b'.repeat(40), false);
    expect(client.compareFileDiffDocument).toHaveBeenCalledWith(
      1,
      'a'.repeat(40),
      'b'.repeat(40),
      false,
      'a.txt',
      { context: state.ws.options.context, ignoreWhitespace: state.ws.options.ignoreWhitespace },
      false,
    );
    mounted.unmount();
    render(<ComparisonDoc doc={target} />);
    await waitFor(() => expect(client.compareRefs).toHaveBeenCalledTimes(2));
    expect(client.resolveRevision).toHaveBeenCalledTimes(2);
  });
  it('로컬 비교에는 초안을 전달하며 오류를 차이 없음으로 표시하지 않는다', async () => {
    const client = createNullClient();
    client.resolveRevision = vi.fn(async () => 'a'.repeat(40));
    client.compareLocalFiles = vi.fn(async () => {
      throw new Error('read denied');
    });
    state.client = client;
    render(<ComparisonDoc doc={{ ...doc(), b: '@LOCAL' }} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('read denied'));
    expect(client.compareLocalFiles).toHaveBeenCalledWith(1, 'a'.repeat(40), [['a.txt', 'draft']]);
  });
});

/** 숨은 세션이 회수되어도 저장소 경로로 다시 얻은 세션을 사용한다. */
it('폴더 비교는 열 때마다 숨은 세션을 다시 확보한다', async () => {
  const client = createNullClient();
  client.compareRefs = vi.fn(async () => []);
  state.client = client;
  state.tab = { id: 20, kind: 'folder' };
  state.openSession.mockImplementation(async (_folder, _repo, run) => {
    run({ id: 9 });
    return true;
  });
  const target = doc();
  const view = render(<ComparisonDoc doc={target} />);
  await waitFor(() => expect(client.compareRefs).toHaveBeenCalledWith(9, 'main', 'feature', false));
  view.unmount();
  state.openSession.mockImplementation(async (_folder, _repo, run) => {
    run({ id: 10 });
    return true;
  });
  render(<ComparisonDoc doc={target} />);
  await waitFor(() =>
    expect(client.compareRefs).toHaveBeenCalledWith(10, 'main', 'feature', false),
  );
});

/** 실제 diff와 명령 레지스트리를 함께 사용해 느린 파일 전환 뒤 F7의 대상을 확인한다. */
it.each(['keyboard', 'button'])(
  '%s 시작 후 F7 반복은 비동기 파일 전환을 이어간다',
  async (start) => {
    const client = createNullClient();
    let refreshGate: Promise<void> | null = null;
    client.compareRefs = async () => {
      if (refreshGate) await refreshGate;
      return ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
        path,
        oldPath: null,
        change: { kind: 'modified' as const },
      }));
    };
    client.compareFileDiffDocument = async (_session, _a, _b, _three, path) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return documentOf({
        oldPath: path,
        newPath: path,
        change: { kind: 'modified' },
        binary: null,
        nonUtf8: false,
        truncated: false,
        totalLines: 2,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            section: '',
            lines: [
              { kind: 'del', oldNo: 1, newNo: null, text: 'old', noNewline: false },
              { kind: 'add', oldNo: null, newNo: 1, text: 'new', noNewline: false },
            ],
          },
        ],
      });
    };
    state.client = client;
    const handler = (event: KeyboardEvent) =>
      handleGlobalKey(event, {
        actions: [
          {
            id: 'diff.nextHunk',
            title: 'next',
            group: 'view',
            scope: 'diff',
            shortcut: 'f7',
            enabled: true,
            run: () => {},
          },
          {
            id: 'diff.previousHunk',
            title: 'previous',
            group: 'view',
            scope: 'diff',
            shortcut: 'shift+f7',
            enabled: true,
            run: () => {},
          },
        ],
        openPalette: () => {},
        searchOpen: false,
        closeSearch: () => {},
        activeDoc: 'pinned',
        closeActiveDoc: () => {},
      });
    document.addEventListener('keydown', handler);
    try {
      const target = doc();
      const { rerender } = render(<ComparisonDoc doc={target} />);
      /** 갱신의 로딩 구간을 확정해 준비 전 화면을 준비 완료로 오인하지 않는다. */
      const refresh = async () => {
        let release = () => {};
        refreshGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const grid = screen.getByRole('grid', { name: 'b.txt' });
        grid.scrollTop = 57;
        fireEvent.click(screen.getByRole('button', { name: S.comparison.refresh }));
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` }).hasAttribute('disabled'),
          ).toBe(true),
        );
        expect(screen.getByRole('grid', { name: 'b.txt' })).toBe(grid);
        expect(grid.scrollTop).toBe(57);
        await act(async () => {
          release();
        });
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` }).hasAttribute('disabled'),
          ).toBe(false),
        );
        expect(screen.getByRole('grid', { name: 'b.txt' })).toBe(grid);
        refreshGate = null;
      };
      const first = await screen.findByRole('grid', { name: 'a.txt' });
      act(() => first.focus());
      if (start === 'keyboard') fireEvent.keyDown(document.activeElement ?? first, { key: 'F7' });
      else fireEvent.click(screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` }));
      expect(document.activeElement?.hasAttribute('data-diff-pane')).toBe(true);
      expect(screen.queryByRole('grid', { name: 'a.txt' })).toBeNull();
      const repeated = new KeyboardEvent('keydown', {
        key: 'F7',
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(document.activeElement ?? document.body, repeated);
      expect(repeated.defaultPrevented).toBe(true);
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('grid', { name: 'b.txt' })),
      );
      // Git 감시 갱신으로 같은 파일을 다시 읽어도 F7의 포커스 대상이 사라지지 않는다.
      await refresh();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('grid', { name: 'b.txt' })),
      );
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F7', repeat: true });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('grid', { name: 'c.txt' })),
      );
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'F7', shiftKey: true });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('grid', { name: 'b.txt' })),
      );
      // 파일 도착 효과(DiffView 의 첫 변경 이동·포커스)는 렌더 뒤 효과라, 위 waitFor 는 같은 커밋의 레이아웃 효과가 준
      // 포커스로 먼저 끝날 수 있다. 남은 효과가 아래 바깥 포커스 뒤에 돌면 포커스를 되가져간다 (waitFor 끝의
      // setTimeout(0) 과 React 효과의 차례가 부하에 따라 바뀐다). 같은 화면을 다시 그려 React 가 새 렌더 전에 남은
      // 효과를 먼저 비우게 한다
      rerender(<ComparisonDoc doc={target} />);
      const outside = document.createElement('input');
      document.body.append(outside);
      act(() => outside.focus());
      await refresh();
      expect(document.activeElement).toBe(outside);
      outside.remove();
    } finally {
      document.removeEventListener('keydown', handler);
    }
  },
);

/** 동일 파일의 자동 갱신 동안 본문 DOM과 읽던 위치를 보존한다. */
it('로컬 감시 갱신은 완료될 때까지 기존 본문과 스크롤을 유지하고 오류도 표시한다', async () => {
  const client = createNullClient();
  const patch = documentOf({ ...documentOf().diff, oldPath: 'a.txt', newPath: 'a.txt' });
  client.compareLocalFiles = vi.fn(async () => ({
    base: 'main',
    files: [{ path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } }],
  }));
  client.compareLocalDocument = vi.fn(async () => patch);
  state.client = client;
  const target = { ...doc(), b: '@LOCAL' };
  const mounted = render(<ComparisonDoc doc={target} />);
  const grid = await screen.findByRole('grid', { name: 'a.txt' });
  grid.scrollTop = 67;
  grid.focus();
  let finish: (value: typeof patch) => void = () => {};
  client.compareLocalDocument = vi.fn(
    () =>
      new Promise<typeof patch>((resolve) => {
        finish = resolve;
      }),
  );
  state.repo.status = {};
  mounted.rerender(<ComparisonDoc doc={target} />);
  await waitFor(() => expect(client.compareLocalDocument).toHaveBeenCalled());
  expect(screen.getByRole('grid', { name: 'a.txt' })).toBe(grid);
  expect(grid.scrollTop).toBe(67);
  expect(document.activeElement).toBe(grid);
  expect(screen.queryByText(S.history.loading)).toBeNull();
  await act(async () => finish(patch));
  expect(screen.getByRole('grid', { name: 'a.txt' })).toBe(grid);
  client.compareLocalFiles = vi.fn(async () => {
    throw new Error('refresh failed');
  });
  state.repo.status = {};
  mounted.rerender(<ComparisonDoc doc={target} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('refresh failed');
  expect(screen.getByRole('grid', { name: 'a.txt' })).toBe(grid);
});

/** 고정 커밋과 표시 옵션은 파일 원문을 다시 읽을 이유가 아니다. */
it('고정 비교는 감시와 표시 옵션으로 재조회하지 않고 공백 옵션만 재조회한다', async () => {
  const client = createNullClient();
  client.compareRefs = vi.fn(async () => [
    { path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } },
  ]);
  client.compareFileDiffDocument = vi.fn(async () =>
    documentOf({ ...documentOf().diff, oldPath: 'a.txt', newPath: 'a.txt' }),
  );
  state.client = client;
  const target = doc();
  const mounted = render(<ComparisonDoc doc={target} />);
  await screen.findByRole('grid', { name: 'a.txt' });
  state.repo.status = {};
  state.repo.refs = { labels: [] };
  state.ws.options = {
    ...state.ws.options,
    wrap: true,
    fullFile: true,
    horizontalSync: false,
    tabWidth: 8,
    highlightMode: 'character',
  };
  mounted.rerender(<ComparisonDoc doc={target} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(client.compareRefs).toHaveBeenCalledTimes(1);
  expect(client.compareFileDiffDocument).toHaveBeenCalledTimes(1);
  state.ws.options = { ...state.ws.options, ignoreWhitespace: true };
  mounted.rerender(<ComparisonDoc doc={target} />);
  await waitFor(() => expect(client.compareFileDiffDocument).toHaveBeenCalledTimes(2));
});

/** 늦게 도착한 문서 응답은 최신 조회 옵션의 결과를 덮지 않는다. */
it('이전 문서 응답이 늦게 도착해도 최신 문서를 유지한다', async () => {
  const client = createNullClient();
  const makeDocument = (text: string) =>
    documentOf({
      ...documentOf().diff,
      oldPath: 'a.txt',
      newPath: 'a.txt',
      totalLines: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          section: '',
          lines: [{ kind: 'add', oldNo: 1, newNo: 1, text, noNewline: false }],
        },
      ],
    });
  client.compareRefs = vi.fn(async () => [
    { path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } },
  ]);
  let finish: (value: ReturnType<typeof documentOf>) => void = () => {};
  client.compareFileDiffDocument = vi.fn((_session, _a, _b, _three, _path, options) =>
    options.ignoreWhitespace
      ? Promise.resolve(makeDocument('fresh result'))
      : new Promise<ReturnType<typeof documentOf>>((resolve) => {
          finish = resolve;
        }),
  );
  state.client = client;
  const target = doc();
  const mounted = render(<ComparisonDoc doc={target} />);
  await waitFor(() => expect(client.compareFileDiffDocument).toHaveBeenCalledTimes(1));
  state.ws.options = { ...state.ws.options, ignoreWhitespace: true };
  mounted.rerender(<ComparisonDoc doc={target} />);
  await screen.findByRole('grid', { name: 'a.txt' });
  expect(screen.getByRole('grid', { name: 'a.txt' }).textContent).toContain('fresh result');
  await act(async () => finish(makeDocument('stale result')));
  expect(screen.getByRole('grid', { name: 'a.txt' }).textContent).toContain('fresh result');
  expect(screen.queryByText('stale result')).toBeNull();
});
