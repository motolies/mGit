import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../layout/Toolbar';
import { useAppStore } from '../store';

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

/** 본문과 독립된 상단 폴더·저장소 탭을 그린다. */
function setup() {
  const close = vi.fn(async () => {});
  act(() =>
    useAppStore.setState({
      sessions: {
        31: { id: 31, kind: 'folder', name: 'folder', path: '/f', parent: null },
        32: { id: 32, kind: 'repo', name: 'child', path: '/f/child', parent: 31 },
      },
      sessionOrder: [31, 32],
      activeSessionId: null,
      requestCloseTabs: close,
    }),
  );
  render(<Toolbar />);
  return { close, tabs: screen.getByRole('tablist', { name: S.toolbar.tabsLabel }) };
}

describe('상단 탭 앱 컨텍스트 메뉴', () => {
  it('우클릭한 탭을 활성화하지 않고 앱 전용 닫기 메뉴를 연다', async () => {
    const { close, tabs } = setup();
    const tab = within(tabs).getByRole('tab', { name: '└ child' });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => tab.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(useAppStore.getState().activeSessionId).toBeNull();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      S.toolbar.closeThisTab,
      S.toolbar.closeOtherTabs,
      S.toolbar.closeAllTabs,
    ]);
    // child와 부모만 있으면 닫을 다른 탭이 없어 이 탭 제외 닫기는 꺼진다.
    expect(
      screen
        .getByRole('menuitem', { name: S.toolbar.closeOtherTabs })
        .getAttribute('data-disabled'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: S.toolbar.closeAllTabs }));
    expect(close).toHaveBeenCalledWith(32, 'all');
  });

  it('Shift+F10으로도 같은 메뉴를 열고 폴더 제외 닫기를 요청한다', () => {
    const { close, tabs } = setup();
    const tab = within(tabs).getByRole('tab', { name: '▣ folder' });
    act(() => {
      tab.focus();
      fireEvent.keyDown(tab, { key: 'F10', shiftKey: true });
    });
    fireEvent.click(screen.getByRole('menuitem', { name: S.toolbar.closeOtherTabs }));
    expect(close).toHaveBeenCalledWith(31, 'others');
  });
});
