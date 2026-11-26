import { createNullClient } from '@mgit/ipc';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComparisonCommits } from '../features/history/ComparisonCommits';

const callbacks = vi.hoisted(() => ({ reveal: vi.fn(), jump: vi.fn(), dock: vi.fn() }));
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      activeSessionId: 10,
      dock: { tool: 'terminal', gitTab: 'log' },
      toggleDock: callbacks.dock,
    }),
  },
}));
vi.mock('../store/session-registry', () => ({
  getFolderStore: () => ({ getState: () => ({ revealTimelineCommit: callbacks.reveal }) }),
  getSessionStore: () => ({
    getState: () => ({ path: '/workspace/repo', jumpToCommit: callbacks.jump }),
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('폴더의 커밋 차이에서 선택하면 경량 세션 그래프 대신 통합 로그로 이동한다', async () => {
  const client = createNullClient();
  client.comparisonCommits = async (_session, include) =>
    include === 'a' ? [[['abc1234567', 'unique change', 'Kim']], false] : [[], false];
  render(<ComparisonCommits client={client} session={11} a="a" b="b" />);
  fireEvent.click(await screen.findByText(/커밋 차이|Commit differences/));
  fireEvent.click(await screen.findByRole('button', { name: /unique change/ }));
  expect(callbacks.reveal).toHaveBeenCalledWith('/workspace/repo', 'abc1234567');
  expect(callbacks.jump).not.toHaveBeenCalled();
  expect(callbacks.dock).toHaveBeenCalledWith('git', 'log');
});
