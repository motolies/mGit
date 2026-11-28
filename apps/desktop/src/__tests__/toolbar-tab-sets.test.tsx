import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../layout/Toolbar';
import { useAppStore } from '../store';
import type { SessionMeta } from '../store/app-store';

vi.mock('../store', async (original) => ({
  ...(await original<typeof import('../store')>()),
  useIsRepoTab: () => false,
  useActiveTab: () => null,
}));
const original = useAppStore.getState();

afterEach(() => {
  cleanup();
  act(() => useAppStore.setState(original));
});

/** 폴더 세트(폴더·하위 저장소), 독립 저장소, 부모가 닫힌 고아 탭을 그린다 (순서는 addTab 이 묶은 그대로) */
function setup(order: number[] = [1, 3, 2, 4]) {
  const sessions: Record<number, SessionMeta> = {
    1: { id: 1, kind: 'folder', name: 'nexkr', path: '/nexkr', parent: null },
    2: { id: 2, kind: 'repo', name: 'mGit', path: '/mgit', parent: null },
    3: { id: 3, kind: 'repo', name: 'deleo-one-ui', path: '/nexkr/one-ui', parent: 1 },
    4: { id: 4, kind: 'repo', name: 'orphan', path: '/nexkr/orphan', parent: 99 },
  };
  act(() => useAppStore.setState({ sessions, sessionOrder: order, activeSessionId: 1 }));
  render(<Toolbar />);
  return screen.getByRole('tablist', { name: S.toolbar.tabsLabel });
}

describe('상단 탭 세트', () => {
  it('세트 멤버는 같은 [data-tab-set] 안에 있고 독립·고아 탭은 그 밖에 있다', () => {
    const tabs = setup();
    const folder = within(tabs).getByRole('tab', { name: 'nexkr' });
    const child = within(tabs).getByRole('tab', { name: 'deleo-one-ui' });
    const set = folder.closest('[data-tab-set]');
    expect(set).not.toBeNull();
    expect(child.closest('[data-tab-set]')).toBe(set);
    expect(within(tabs).getByRole('tab', { name: 'mGit' }).closest('[data-tab-set]')).toBeNull();
    expect(within(tabs).getByRole('tab', { name: 'orphan' }).closest('[data-tab-set]')).toBeNull();
    // 세트 칸은 역할이 없어 tablist 아래 탭 구조가 그대로다
    expect(set?.getAttribute('role')).toBeNull();
  });

  it('하위 탭의 설명·툴팁에 연 곳을 덧붙이고, 고아 탭은 └ 없이 독립 탭처럼 보인다', () => {
    const tabs = setup();
    const child = within(tabs).getByRole('tab', { name: 'deleo-one-ui' });
    const from = S.toolbar.openedFrom('nexkr');
    expect(child.getAttribute('aria-description')).toContain(from);
    expect(child.getAttribute('aria-description')).toContain(S.home.repo);
    expect(child.title).toContain(from);
    expect(child.textContent).toContain('└');
    const orphan = within(tabs).getByRole('tab', { name: 'orphan' });
    expect(orphan.textContent).not.toContain('└');
    expect(orphan.getAttribute('aria-description')).toBe(S.home.repo);
  });

  it('화면의 탭 순서와 ←→ 이동 순서가 같다', () => {
    const tabs = setup();
    const names = within(tabs)
      .getAllByRole('tab')
      .map((tab) => tab.textContent?.replace('└', ''));
    expect(names).toEqual(['nexkr', 'deleo-one-ui', 'mGit', 'orphan']);
    const visited: string[] = [];
    let current = within(tabs).getByRole('tab', { name: 'nexkr' });
    act(() => current.focus());
    for (let i = 0; i < 4; i++) {
      act(() => {
        fireEvent.keyDown(current, { key: 'ArrowRight' });
      });
      current = document.activeElement as HTMLElement;
      visited.push(current.textContent?.replace('└', '') ?? '');
    }
    expect(visited).toEqual(['deleo-one-ui', 'mGit', 'orphan', 'nexkr']);
  });
});
