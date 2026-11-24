import { GraphRangeCache, type GraphWindow, MockGraphSource, type RefLabel } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphView } from '../GraphView';

vi.mock('../paint', () => ({ paint: vi.fn() }));
afterEach(cleanup);

/** 같은 커밋에 새로 붙은 원격 브랜치를 만든다. */
function remoteOf(local: RefLabel): RefLabel {
  return {
    ...local,
    fullName: `refs/remotes/origin/${local.shortName}`,
    shortName: `origin/${local.shortName}`,
    kind: { kind: 'remoteBranch', remote: 'origin' },
    isCurrent: false,
  };
}

describe('통합 그래프 원격 ref 갱신', () => {
  it('행 수·OID가 같아도 재로드 뒤 원격 라벨을 다시 읽어 짝지어 표시한다', async () => {
    const mock = new MockGraphSource({ rows: 2, latencyMs: 0 });
    const original = await mock.fetchWindow(0, 2);
    const first = original.rows[0];
    if (!first) throw new Error('첫 행이 없습니다');
    const local = first.refs.find((ref) => ref.kind.kind === 'localBranch');
    if (!local) throw new Error('로컬 브랜치가 없습니다');
    let window: GraphWindow = {
      ...original,
      rows: original.rows.map((row, index) => ({
        ...row,
        repo: index,
        refs: index === 0 ? [local] : [],
      })),
    };
    const fetchWindow = vi.fn(async () => window);
    const cache = new GraphRangeCache({ fetchWindow });
    cache.setTotalRows(2, true);
    const { container } = render(
      <GraphView
        cache={cache}
        totalRows={2}
        columns={{ author: true, date: true, hash: true, repo: true }}
        initialRect={{ width: 1200, height: 240 }}
      />,
    );
    const row = () => container.querySelector('[data-row="0"]');
    await waitFor(() => expect(row()?.textContent).toContain(local.shortName));
    expect(row()?.textContent).not.toContain(S.graph.refs.paired('origin', local.shortName));

    window = {
      ...window,
      generation: window.generation + 1,
      rows: window.rows.map((item, index) =>
        index === 0 ? { ...item, refs: [local, remoteOf(local)] } : item,
      ),
    };
    act(() => cache.invalidateAll());
    await waitFor(() =>
      expect(row()?.textContent).toContain(S.graph.refs.paired('origin', local.shortName)),
    );
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-row="1"]')?.textContent).not.toContain('origin');
    cache.dispose();
  });
});
