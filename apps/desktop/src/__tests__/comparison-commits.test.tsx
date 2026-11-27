import { createNullClient, type IpcClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** 커밋 차이 응답 */
type CommitsReply = [[string, string, string][], boolean];

/** `<details>` 를 펼치거나 접는다 (브라우저처럼 `open` 을 바꾸고 `toggle` 을 보낸다) */
function toggle(open: boolean) {
  const details = screen.getByText(S.comparison.commits).closest('details');
  if (!details) throw new Error('details 없음');
  act(() => {
    details.open = open;
    details.dispatchEvent(new Event('toggle'));
  });
}

describe('펼칠 때 조회 (G5)', () => {
  it('접혀 있으면 묻지 않고, 펼치면 양쪽을 한 번 묻고, 다시 접었다 펼쳐도 다시 묻지 않는다', async () => {
    const client = createNullClient();
    const commits = vi.fn<IpcClient['comparisonCommits']>(
      async (_s, include): Promise<CommitsReply> => [
        [[`${include}1`.padEnd(40, '0'), '커밋', '작성자']],
        false,
      ],
    );
    client.comparisonCommits = commits;
    render(<ComparisonCommits client={client} session={1} a="a" b="b" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(commits).not.toHaveBeenCalled();
    toggle(true);
    await screen.findByText(`${S.comparison.onlyA} (1`, { exact: false });
    expect(commits).toHaveBeenCalledTimes(2);
    expect(commits).toHaveBeenCalledWith(1, 'a', 'b');
    expect(commits).toHaveBeenCalledWith(1, 'b', 'a');
    toggle(false);
    toggle(true);
    expect(commits).toHaveBeenCalledTimes(2);
  });

  it('두 시점이 바뀌면 펼쳐 있을 때 새로 묻는다', async () => {
    const client = createNullClient();
    const commits = vi.fn<IpcClient['comparisonCommits']>(
      async (): Promise<CommitsReply> => [[], false],
    );
    client.comparisonCommits = commits;
    const view = render(<ComparisonCommits client={client} session={1} a="a" b="b" />);
    toggle(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits).toHaveBeenCalledTimes(2);
    view.rerender(<ComparisonCommits client={client} session={1} a="a" b="c" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(commits).toHaveBeenCalledTimes(4);
    expect(commits).toHaveBeenLastCalledWith(1, 'c', 'a');
  });
});
