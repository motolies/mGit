// WIP 행 → Commit 도구 창 (W21 ②)이 기대는 그래프 뷰의 계약: `onSelectWip` 은 WIP 행의 명시 활성화(클릭·그 행에서
// Enter)에만 불리고, 로그의 키보드 이동(↑↓·Home·End·PageUp·PageDown)은 WIP 행을 고르지 않는다. 저장소 탭의
// `GraphPane` 이 `onSelectWip` 에 "Commit 도구 창 열기"를 걸므로, 키로 로그를 훑는 동안 왼쪽 도구 창이 바뀌지 않는다.
// `packages/graph-view` 는 고치지 않는다 — 그 동작을 여기서 고정한다.

import { GraphView } from '@mgit/graph-view';
import { GraphRangeCache, MockGraphSource } from '@mgit/ipc';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

/** 지연 없는 목 출처와 캐시 */
function setup(rows: number) {
  const source = new MockGraphSource({ rows, latencyMs: 0 });
  const cache = new GraphRangeCache(source);
  cache.setTotalRows(rows, true);
  return cache;
}

/** 다음 매크로태스크까지 기다린다 (fetchWindow 의 Promise 해소) */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** 저장소 탭처럼 WIP 행이 있고 고른 행을 바깥이 쥐는 로그 */
function Log({ cache, onActivateWip }: { cache: GraphRangeCache; onActivateWip: () => void }) {
  const [oid, setOid] = useState<string | null>(null);
  const [wip, setWip] = useState(false);
  return (
    <GraphView
      cache={cache}
      totalRows={50}
      rowHeight={24}
      initialRect={{ width: 800, height: 240 }}
      wipRow={{ staged: 1, unstaged: 2, untracked: 0, conflicted: 1 } as never}
      wipSelected={wip}
      onSelectWip={() => {
        setWip(true);
        setOid(null);
        onActivateWip();
      }}
      selectedOid={oid}
      onSelectRow={(row) => {
        setWip(false);
        setOid(row.oid);
      }}
    />
  );
}

describe('WIP 행: 선택(키보드 이동)과 활성화(클릭·Enter)의 구분', () => {
  it('↑↓·Home·End·PageUp·PageDown 으로 로그를 훑어도 WIP 행 활성화가 불리지 않는다', async () => {
    const cache = setup(50);
    const onActivateWip = vi.fn();
    const { container } = render(<Log cache={cache} onActivateWip={onActivateWip} />);
    await flush();
    await flush();
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    grid.focus();
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'Home']) {
      fireEvent.keyDown(grid, { key });
      await flush();
    }
    for (const key of ['PageDown', 'End', 'PageUp', 'Home', 'ArrowUp']) {
      fireEvent.keyDown(grid, { key });
      await flush();
    }
    expect(onActivateWip).not.toHaveBeenCalled();
    // 맨 위에서 ↑ 를 눌러도 WIP 행으로 가지 않는다 (고른 행은 첫 commit 행)
    expect(container.querySelector('[data-row="wip"]')?.getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('WIP 행을 누르거나 그 행에서 Enter 를 누르면 활성화가 한 번씩 불린다', async () => {
    const cache = setup(50);
    const onActivateWip = vi.fn();
    const { container } = render(<Log cache={cache} onActivateWip={onActivateWip} />);
    await flush();
    const wip = container.querySelector('[data-row="wip"]') as HTMLElement;
    fireEvent.click(wip);
    expect(onActivateWip).toHaveBeenCalledTimes(1);
    expect(wip.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(wip, { key: 'Enter' });
    expect(onActivateWip).toHaveBeenCalledTimes(2);
  });
});
