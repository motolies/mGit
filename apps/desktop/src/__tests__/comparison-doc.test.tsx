import { createNullClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(cleanup);
beforeEach(() => {
  state.tab = null;
  state.client = createNullClient();
  state.repo.status = {};
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
      state.ws.options,
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
      const mounted = render(<ComparisonDoc doc={target} />);
      /** 갱신의 로딩 구간을 확정해 준비 전 화면을 준비 완료로 오인하지 않는다. */
      const refresh = async () => {
        let release = () => {};
        refreshGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        state.repo.status = {};
        mounted.rerender(<ComparisonDoc doc={target} />);
        await waitFor(() => expect(screen.queryByRole('grid', { name: 'b.txt' })).toBeNull());
        await act(async () => {
          release();
        });
        await screen.findByRole('grid', { name: 'b.txt' });
        refreshGate = null;
      };
      const first = await screen.findByRole('grid', { name: 'a.txt' });
      act(() => first.focus());
      if (start === 'keyboard') fireEvent.keyDown(document.activeElement ?? first, { key: 'F7' });
      else fireEvent.click(screen.getByRole('button', { name: `↓ ${S.diff.nextChange}` }));
      expect(document.activeElement?.hasAttribute('data-diff-pane')).toBe(true);
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
