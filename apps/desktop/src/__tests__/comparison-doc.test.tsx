import { createNullClient } from '@mgit/ipc';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonDoc } from '../features/history/ComparisonDoc';
import type { ComparisonTarget } from '../store/workspace-store';
import { documentOf } from './diff-document-fixture';

const state = vi.hoisted(() => ({
  client: null as unknown,
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
vi.mock('../features/diff/DiffPaneView', () => ({
  DiffPaneView: ({ document }: { document: ReturnType<typeof documentOf> | null }) => (
    <div data-testid="comparison-content">{document?.new.content}</div>
  ),
}));
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
