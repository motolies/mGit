import { createNullClient, type FsEditableFile } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonDoc } from '../features/history/ComparisonDoc';
import { handleGlobalKey } from '../global-keys';
import { fileEditors } from '../store/file-editor-store';
import type { ComparisonTarget } from '../store/workspace-store';
import { documentOf } from './diff-document-fixture';

const state = vi.hoisted(() => ({
  client: null as unknown,
  shortcutOverrides: {},
  tab: null as { id: number; kind: string } | null,
  /** 편집기 초안 (`comparisonDrafts`) */
  drafts: [['a.txt', 'draft']] as [string, string][],
  /** 로컬 비교의 재조회 신호 (`comparisonStamp`) — 저장소·파일마다 다른 값을 줄 수 있다 */
  stamp: (_root: string, _path?: string): string => '',
  openSession: vi.fn(),
  repo: {
    refs: { head: {}, labels: [] } as { head: unknown; labels: unknown[] },
    status: {},
    fetch: async () => {},
    busy: false,
    lastFetchAt: null,
  },
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
  comparisonDrafts: () => state.drafts,
  comparisonStamp: (root: string, path?: string) => state.stamp(root, path),
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
/** 시험용 로컬 브랜치 라벨 */
const branch = (name: string, current = false) => ({
  fullName: `refs/heads/${name}`,
  shortName: name,
  kind: { kind: 'localBranch' as const },
  target: 'c'.repeat(40),
  isCurrent: current,
  upstreamGone: false,
});
/** 세션의 ref 스냅샷 (HEAD 는 main, 로컬 브랜치 main·feature·topic). 부를 때마다 새 객체다 (감시 신호 흉내) */
const repoRefs = () => ({
  head: { state: 'attached' as const, branch: 'main', oid: 'c'.repeat(40) },
  labels: [branch('main', true), branch('feature'), branch('topic')],
});
beforeEach(() => {
  state.repo.refs = repoRefs();
  state.tab = null;
  state.drafts = [['a.txt', 'draft']];
  state.stamp = () => '';
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
/** 편집기 저장소에 열 텍스트 파일 응답 */
const textFile = (text: string): FsEditableFile => ({
  kind: 'text',
  text,
  size: text.length,
  bom: false,
  lineEnding: 'lf',
  fileKey: `comparison-${text}`,
  revision: '1',
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
    // 탭으로 돌아오면 같은 OID 의 결과를 그대로 보이고 다시 해석하지도 조회하지도 않는다 (G5)
    render(<ComparisonDoc doc={target} />);
    expect(screen.getByRole('grid', { name: 'a.txt' })).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(client.resolveRevision).toHaveBeenCalledTimes(2);
    expect(client.compareRefs).toHaveBeenCalledTimes(1);
    expect(client.compareFileDiffDocument).toHaveBeenCalledTimes(1);
    // "비교 새로고침" 만 같은 ref 를 다시 해석해 다시 조회한다
    fireEvent.click(screen.getByRole('button', { name: S.comparison.refresh }));
    await waitFor(() => expect(client.compareRefs).toHaveBeenCalledTimes(2));
    expect(client.resolveRevision).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(client.compareFileDiffDocument).toHaveBeenCalledTimes(2));
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
  state.repo.refs = repoRefs();
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

describe('로컬 비교의 재조회와 깜빡임 (F2)', () => {
  /** 수동으로 끝내는 응답 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  /** 배경 갱신의 묶음 시간(300ms)이 지나도록 기다린다 */
  const debounce = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
  /** Git 감시 신호(status 객체 교체)를 보낸다 */
  const watchSignal = (view: ReturnType<typeof render>, target: ComparisonTarget) => {
    state.repo.status = {};
    view.rerender(<ComparisonDoc doc={target} />);
  };
  const modified = (path: string) => ({
    path,
    oldPath: null,
    change: { kind: 'modified' as const },
  });
  /** 그 파일의 한 줄 바뀐 문서 */
  const patchOf = (path: string) =>
    documentOf({
      ...documentOf().diff,
      oldPath: path,
      newPath: path,
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
  const local = (): ComparisonTarget => ({ ...doc(), b: '@LOCAL' });

  it('첫 조회는 지연 없이 나간다', async () => {
    const client = createNullClient();
    client.resolveRevision = vi.fn(async () => 'a'.repeat(40));
    client.compareLocalFiles = vi.fn(async () => ({ base: 'a'.repeat(40), files: [] }));
    state.client = client;
    vi.useFakeTimers();
    try {
      render(<ComparisonDoc doc={local()} />);
      await act(async () => {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
      expect(client.compareLocalFiles).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('편집기 저장소가 알려도 이 저장소의 초안 지문이 같으면 다시 묻지도 그리지도 않고, 지문이 바뀌면 다시 묻는다', async () => {
    const client = createNullClient();
    client.compareLocalFiles = vi.fn(async () => ({ base: 'main', files: [modified('a.txt')] }));
    client.compareLocalDocument = vi.fn(async () => patchOf('a.txt'));
    state.client = client;
    let mine = 'a.txt:1';
    state.stamp = (root) => (root === '/repo' ? mine : 'other');
    const commits = { n: 0 };
    const target = local();
    const tree = () => (
      <Profiler
        id="comparison"
        onRender={() => {
          commits.n += 1;
        }}
      >
        <ComparisonDoc doc={target} />
      </Profiler>
    );
    const view = render(tree());
    await screen.findByRole('grid', { name: 'a.txt' });
    await debounce();
    const calls = () => [
      vi.mocked(client.compareLocalFiles).mock.calls.length,
      vi.mocked(client.compareLocalDocument).mock.calls.length,
    ];
    const before = calls();
    const settled = commits.n;
    // 다른 저장소의 문서가 바뀌어 편집기 저장소가 알린다 (이 저장소 지문은 그대로)
    const other = await fileEditors.open(
      { ...createNullClient(), fsReadEditableFile: async () => textFile('x') },
      4242,
      'x.ts',
    );
    await act(async () => {
      if ('fileKey' in other)
        fileEditors.update(other, other.state.update({ changes: { from: 0, insert: 'y' } }).state);
      await fileEditors.refreshAll();
    });
    await debounce();
    expect(calls()).toEqual(before);
    expect(commits.n).toBe(settled);
    // 이 저장소의 초안이 바뀌면 다시 묻는다
    mine = 'a.txt:2';
    view.rerender(tree());
    await debounce();
    await waitFor(() => expect(calls()[0]).toBe((before[0] ?? 0) + 1));
    await fileEditors.discard(4242);
    fileEditors.releaseSession(4242);
  });

  it('빈 목록("차이 없음")에서 배경 갱신이 와도 로딩 문구가 끼어들지 않고 "차이 없음"이 남는다', async () => {
    const client = createNullClient();
    client.compareLocalFiles = vi.fn(async () => ({ base: 'main', files: [] }));
    state.client = client;
    const target = local();
    const view = render(<ComparisonDoc doc={target} />);
    await screen.findByText(S.history.noDiff);
    const pending = deferred<{ base: string; files: never[] }>();
    client.compareLocalFiles = vi.fn(() => pending.promise);
    watchSignal(view, target);
    await debounce();
    expect(client.compareLocalFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(S.history.loading)).toBeNull();
    expect(screen.getByText(S.history.noDiff)).toBeTruthy();
    await act(async () => pending.resolve({ base: 'main', files: [] }));
    expect(screen.queryByText(S.history.loading)).toBeNull();
    expect(screen.getByText(S.history.noDiff)).toBeTruthy();
  });

  it('배경 갱신 중 이전·다음 파일 단추가 꺼졌다 켜지지 않는다', async () => {
    const client = createNullClient();
    client.compareLocalFiles = vi.fn(async () => ({
      base: 'main',
      files: [modified('a.txt'), modified('b.txt')],
    }));
    client.compareLocalDocument = vi.fn(async (_s, _b, path) => patchOf(path));
    state.client = client;
    const target = local();
    const view = render(<ComparisonDoc doc={target} />);
    await screen.findByRole('grid', { name: 'a.txt' });
    const next = () => screen.getByRole('button', { name: `${S.diff.nextFile} →` });
    expect(next().hasAttribute('disabled')).toBe(false);
    const changes: boolean[] = [];
    const observer = new MutationObserver(() => changes.push(next().hasAttribute('disabled')));
    observer.observe(next(), { attributes: true, attributeFilter: ['disabled'] });
    const pending = deferred<{ base: string; files: ReturnType<typeof modified>[] }>();
    client.compareLocalFiles = vi.fn(() => pending.promise);
    watchSignal(view, target);
    await debounce();
    expect(next().hasAttribute('disabled')).toBe(false);
    await act(async () =>
      pending.resolve({ base: 'main', files: [modified('a.txt'), modified('b.txt')] }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    observer.disconnect();
    expect(changes).toEqual([]);
    expect(next().hasAttribute('disabled')).toBe(false);
  });

  it('오류가 떠 있을 때 배경 갱신이 와도 경고가 남고, 성공하면 사라진다', async () => {
    const client = createNullClient();
    client.compareLocalFiles = vi.fn(async () => ({ base: 'main', files: [modified('a.txt')] }));
    client.compareLocalDocument = vi.fn(async () => patchOf('a.txt'));
    state.client = client;
    const target = local();
    const view = render(<ComparisonDoc doc={target} />);
    await screen.findByRole('grid', { name: 'a.txt' });
    client.compareLocalFiles = vi.fn(async () => {
      throw new Error('watch refresh failed');
    });
    watchSignal(view, target);
    await debounce();
    await screen.findByRole('alert');
    const pending = deferred<{ base: string; files: ReturnType<typeof modified>[] }>();
    client.compareLocalFiles = vi.fn(() => pending.promise);
    watchSignal(view, target);
    await debounce();
    expect(screen.getByRole('alert').textContent).toContain('watch refresh failed');
    await act(async () => pending.resolve({ base: 'main', files: [modified('a.txt')] }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('grid', { name: 'a.txt' })).toBeTruthy();
  });

  it('긴 조회 도중 신호가 여러 번 와도 첫 결과를 적용하고 끝난 뒤 한 번만 다시 묻는다', async () => {
    const client = createNullClient();
    client.compareLocalFiles = vi.fn(async () => ({ base: 'main', files: [modified('a.txt')] }));
    client.compareLocalDocument = vi.fn(async (_s, _b, path) => patchOf(path));
    state.client = client;
    const target = local();
    const view = render(<ComparisonDoc doc={target} />);
    await screen.findByRole('grid', { name: 'a.txt' });
    const slow = deferred<{ base: string; files: ReturnType<typeof modified>[] }>();
    const replies = [slow.promise];
    client.compareLocalFiles = vi.fn(
      () => replies.shift() ?? Promise.resolve({ base: 'main', files: [modified('b.txt')] }),
    );
    watchSignal(view, target);
    await debounce();
    expect(client.compareLocalFiles).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i += 1) {
      watchSignal(view, target);
      await debounce();
    }
    expect(client.compareLocalFiles).toHaveBeenCalledTimes(1);
    await act(async () =>
      slow.resolve({ base: 'main', files: [modified('a.txt'), modified('c.txt')] }),
    );
    await waitFor(() => expect(client.compareLocalFiles).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(client.compareLocalFiles).toHaveBeenCalledTimes(2);
  });

  describe('파일 비교 (filterPath)', () => {
    const fileTarget = (): ComparisonTarget => ({ ...local(), filterPath: 'a.txt' });

    it('저장소 전체 목록을 묻지 않고 문서 하나로 변경 있음을 보인다', async () => {
      const client = createNullClient();
      client.compareLocalFiles = vi.fn(async () => ({ base: 'main', files: [] }));
      client.compareLocalDocument = vi.fn(async () => patchOf('a.txt'));
      state.client = client;
      render(<ComparisonDoc doc={fileTarget()} />);
      await screen.findByRole('grid', { name: 'a.txt' });
      expect(client.compareLocalFiles).not.toHaveBeenCalled();
      expect(client.compareLocalDocument).toHaveBeenCalledTimes(1);
      expect(client.compareLocalDocument).toHaveBeenCalledWith(
        1,
        'main',
        'a.txt',
        'draft',
        { context: 3, ignoreWhitespace: false },
        false,
      );
    });

    it('내용이 같으면 "차이 없음"이고, 이름을 바꾼 파일은 옛 이름을 보인다', async () => {
      const client = createNullClient();
      const same = documentOf({
        ...documentOf().diff,
        oldPath: 'a.txt',
        newPath: 'a.txt',
        hunks: [],
      });
      client.compareLocalDocument = vi.fn(async () => same);
      client.compareLocalFiles = vi.fn(async () => ({ base: 'main', files: [] }));
      state.client = client;
      const first = render(<ComparisonDoc doc={fileTarget()} />);
      await screen.findByText(S.history.noDiff);
      expect(client.compareLocalFiles).not.toHaveBeenCalled();
      first.unmount();
      const renamed = documentOf({
        ...documentOf().diff,
        oldPath: 'old.txt',
        newPath: 'a.txt',
        change: { kind: 'renamed', similarity: 90 },
        hunks: [],
      });
      renamed.old = { ...renamed.old, path: 'old.txt' };
      renamed.new = { ...renamed.new, path: 'a.txt' };
      client.compareLocalDocument = vi.fn(async () => renamed);
      render(<ComparisonDoc doc={fileTarget()} />);
      await screen.findByText(S.changes.renamedFrom('old.txt'));
      expect(client.compareLocalFiles).not.toHaveBeenCalled();
    });

    it('로컬 쪽에서 파일이 사라졌으면 다른 이름으로 옮겼는지 목록으로 가린다', async () => {
      const client = createNullClient();
      const gone = documentOf({ ...documentOf().diff, oldPath: 'a.txt', newPath: null });
      gone.old = { ...gone.old, path: 'a.txt' };
      gone.new = { ...gone.new, path: null };
      client.compareLocalDocument = vi.fn(async () => gone);
      client.compareLocalFiles = vi.fn(async () => ({
        base: 'main',
        files: [
          {
            path: 'b.txt',
            oldPath: 'a.txt',
            change: { kind: 'renamed' as const, similarity: 100 },
          },
        ],
      }));
      state.client = client;
      render(<ComparisonDoc doc={fileTarget()} />);
      await screen.findByText(S.changes.renamedFrom('a.txt'));
      expect(client.compareLocalFiles).toHaveBeenCalledTimes(1);
    });
  });
});

describe('기준·대상 칸 (F4)', () => {
  /** 이름 → 시험용 OID (모르는 이름이면 해석 실패) */
  const OIDS: Record<string, string> = {
    main: 'a'.repeat(40),
    feature: 'b'.repeat(40),
    'refs/heads/main': 'a'.repeat(40),
    'refs/heads/feature': 'b'.repeat(40),
    'refs/heads/topic': 'd'.repeat(40),
    'HEAD~3': 'e'.repeat(40),
  };
  /** 비교 클라이언트: 이름을 OID 로 해석하고 파일 하나를 돌려준다 */
  function compareClient() {
    const client = createNullClient();
    client.resolveRevision = vi.fn(async (_session, rev: string) => {
      const oid = OIDS[rev];
      if (!oid) throw new Error(`unknown revision ${rev}`);
      return oid;
    });
    client.compareRefs = vi.fn(async () => [
      { path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } },
    ]);
    client.compareFileDiffDocument = vi.fn(async () =>
      documentOf({ ...documentOf().diff, oldPath: 'a.txt', newPath: 'a.txt' }),
    );
    state.client = client;
    return client;
  }
  /** 칸(팝오버를 여는 단추). 이름은 "기준 (A): …" 꼴이다 */
  const picker = (label: string) => {
    const found = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith(`${label}:`));
    if (!found) throw new Error(`칸 없음: ${label}`);
    return found;
  };
  const pickerA = () => picker(S.history.compareA);
  const pickerB = () => picker(S.history.compareB);
  /** 열린 칸의 검색칸 (그 칸의 팝오버 안) */
  const searchBox = () => within(screen.getByRole('dialog')).getByRole('combobox');
  /** 칸을 열어 검색어를 넣고 Enter 로 고른다 */
  const choose = async (trigger: HTMLElement, query: string) => {
    fireEvent.click(trigger);
    const input = searchBox();
    fireEvent.change(input, { target: { value: query } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
  };

  it('목록에서 고르면 "비교 새로고침" 없이 바로 새 기준으로 다시 비교한다', async () => {
    const client = compareClient();
    render(<ComparisonDoc doc={doc()} />);
    await waitFor(() =>
      expect(client.compareRefs).toHaveBeenCalledWith(1, 'a'.repeat(40), 'b'.repeat(40), false),
    );
    await choose(pickerB(), 'topic');
    await waitFor(() =>
      expect(client.compareRefs).toHaveBeenLastCalledWith(1, 'a'.repeat(40), 'd'.repeat(40), false),
    );
    expect(client.resolveRevision).toHaveBeenCalledWith(1, 'refs/heads/topic');
    expect(pickerB().getAttribute('aria-label')).toContain('topic');
  });

  it('방향 전환과 three-dot 은 누르는 즉시 적용한다', async () => {
    const client = compareClient();
    render(<ComparisonDoc doc={doc()} />);
    await waitFor(() => expect(client.compareRefs).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: S.comparison.swap }));
    await waitFor(() =>
      expect(client.compareRefs).toHaveBeenLastCalledWith(1, 'b'.repeat(40), 'a'.repeat(40), false),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: S.history.threeDot }));
    await waitFor(() =>
      expect(client.compareRefs).toHaveBeenLastCalledWith(1, 'b'.repeat(40), 'a'.repeat(40), true),
    );
    expect(client.compareRefs).toHaveBeenCalledTimes(3);
  });

  it('대상이 현재 로컬 내용이면 방향 전환과 three-dot 을 쓸 수 없고, 로컬 내용을 고르면 three-dot 이 꺼진다', async () => {
    const client = compareClient();
    client.compareLocalFiles = vi.fn(async () => ({ base: 'a'.repeat(40), files: [] }));
    render(<ComparisonDoc doc={{ ...doc(), threeDot: true }} />);
    await waitFor(() =>
      expect(client.compareRefs).toHaveBeenLastCalledWith(1, 'a'.repeat(40), 'b'.repeat(40), true),
    );
    fireEvent.click(pickerB());
    fireEvent.keyDown(searchBox(), { key: 'Home' });
    await act(async () => {
      fireEvent.keyDown(searchBox(), { key: 'Enter' });
    });
    await waitFor(() => expect(client.compareLocalFiles).toHaveBeenCalled());
    const three = screen.getByRole('checkbox', { name: S.history.threeDot }) as HTMLInputElement;
    expect(three.disabled).toBe(true);
    expect(three.checked).toBe(false);
    expect(screen.getByRole('button', { name: S.comparison.swap }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('찾을 수 없는 직접 입력은 칸 안에서 알리고 기존 비교를 그대로 둔다', async () => {
    const client = compareClient();
    render(<ComparisonDoc doc={doc()} />);
    await screen.findByRole('grid', { name: 'a.txt' });
    const before = vi.mocked(client.compareRefs).mock.calls.length;
    await choose(pickerA(), 'nope~1');
    expect(searchBox().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('nope~1'))).toBe(true);
    expect(client.compareRefs).toHaveBeenCalledTimes(before);
    expect(screen.getByRole('grid', { name: 'a.txt' })).toBeTruthy();
    // 확인되는 식은 그대로 적용한다
    fireEvent.change(searchBox(), { target: { value: 'HEAD~3' } });
    await act(async () => {
      fireEvent.keyDown(searchBox(), { key: 'Enter' });
    });
    await waitFor(() =>
      expect(client.compareRefs).toHaveBeenLastCalledWith(1, 'e'.repeat(40), 'b'.repeat(40), false),
    );
  });

  it('적용한 값을 해석하지 못하면 그 칸에 표시하고 오류를 알린다', async () => {
    compareClient();
    render(<ComparisonDoc doc={{ ...doc(), b: 'gone' }} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('unknown revision gone');
    expect(pickerB().dataset.invalid).toBe('true');
    expect(pickerA().dataset.invalid).toBeUndefined();
  });

  it('"원격 정보 가져온 뒤 비교" 는 지금 고른 값으로 다시 해석해 비교한다', async () => {
    const client = compareClient();
    const fetch = vi.fn(async () => {});
    state.repo.fetch = fetch;
    try {
      render(<ComparisonDoc doc={doc()} />);
      await waitFor(() => expect(client.compareRefs).toHaveBeenCalledTimes(1));
      await choose(pickerB(), 'topic');
      await waitFor(() => expect(client.compareRefs).toHaveBeenCalledTimes(2));
      const resolved = vi.mocked(client.resolveRevision).mock.calls.length;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: S.comparison.fetchRefresh }));
      });
      expect(fetch).toHaveBeenCalledWith(null, false);
      await waitFor(() => expect(client.compareRefs).toHaveBeenCalledTimes(3));
      expect(client.compareRefs).toHaveBeenLastCalledWith(1, 'a'.repeat(40), 'd'.repeat(40), false);
      expect(
        vi
          .mocked(client.resolveRevision)
          .mock.calls.slice(resolved)
          .map((c) => c[1]),
      ).toEqual(['main', 'refs/heads/topic']);
    } finally {
      state.repo.fetch = async () => {};
    }
  });
});

describe('비교 첫 열기와 탭 복귀 (G5)', () => {
  /** 이름 → OID, 파일 하나, 문서 하나를 돌려주는 클라이언트 */
  function fixedClient() {
    const client = createNullClient();
    client.resolveRevision = vi.fn(async (_session, rev: string) =>
      rev === 'main' ? 'a'.repeat(40) : 'b'.repeat(40),
    );
    client.compareRefs = vi.fn(async () => [
      { path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } },
    ]);
    client.compareFileDiffDocument = vi.fn(async () =>
      documentOf({ ...documentOf().diff, oldPath: 'a.txt', newPath: 'a.txt' }),
    );
    state.client = client;
    return client;
  }
  /** 테스트에서 센 IPC 수 */
  const counts = (client: ReturnType<typeof fixedClient>) => ({
    resolve: vi.mocked(client.resolveRevision).mock.calls.length,
    compareRefs: vi.mocked(client.compareRefs).mock.calls.length,
    document: vi.mocked(client.compareFileDiffDocument).mock.calls.length,
  });

  it('처음 열면 기준·대상을 함께 해석하고 목록·문서를 한 번씩 묻는다', async () => {
    const client = fixedClient();
    const pending: ((oid: string) => void)[] = [];
    client.resolveRevision = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pending.push(resolve);
        }),
    );
    render(<ComparisonDoc doc={doc()} />);
    // 하나가 끝나기 전에 둘 다 나간다 (직렬이면 첫 해석이 끝나야 둘째가 나간다)
    await waitFor(() => expect(client.resolveRevision).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.resolveRevision).mock.calls.map((c) => c[1])).toEqual([
      'main',
      'feature',
    ]);
    await act(async () => {
      pending[0]?.('a'.repeat(40));
      pending[1]?.('b'.repeat(40));
    });
    await screen.findByRole('grid', { name: 'a.txt' });
    expect(counts(client)).toEqual({ resolve: 2, compareRefs: 1, document: 1 });
    expect(client.compareRefs).toHaveBeenCalledWith(1, 'a'.repeat(40), 'b'.repeat(40), false);
  });

  it('고정 OID 비교는 둔 결과가 많아지면 가장 오래된 것부터 버리고, 버린 문서는 돌아올 때 다시 묻는다', async () => {
    const client = fixedClient();
    const targets = Array.from({ length: 7 }, () => doc());
    for (const target of targets) {
      const view = render(<ComparisonDoc doc={target} />);
      await screen.findByRole('grid', { name: 'a.txt' });
      view.unmount();
    }
    expect(counts(client).compareRefs).toBe(7);
    // 가장 최근 것은 그대로 보인다
    const recent = render(<ComparisonDoc doc={targets[6] as ComparisonTarget} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(counts(client).compareRefs).toBe(7);
    recent.unmount();
    // 가장 오래된 것은 버려져 다시 묻는다
    render(<ComparisonDoc doc={targets[0] as ComparisonTarget} />);
    await waitFor(() => expect(counts(client).compareRefs).toBe(8));
  });

  it('로컬 내용과의 비교는 결과를 두지 않고 돌아올 때 다시 묻는다', async () => {
    const client = fixedClient();
    client.compareLocalFiles = vi.fn(async () => ({
      base: 'a'.repeat(40),
      files: [{ path: 'a.txt', oldPath: null, change: { kind: 'modified' as const } }],
    }));
    client.compareLocalDocument = vi.fn(async () =>
      documentOf({ ...documentOf().diff, oldPath: 'a.txt', newPath: 'a.txt' }),
    );
    const target = { ...doc(), b: '@LOCAL' };
    const first = render(<ComparisonDoc doc={target} />);
    await screen.findByRole('grid', { name: 'a.txt' });
    first.unmount();
    render(<ComparisonDoc doc={target} />);
    await waitFor(() => expect(client.compareLocalFiles).toHaveBeenCalledTimes(2));
  });
});
